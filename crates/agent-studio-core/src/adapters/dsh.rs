//! DSH（DeepSeek Harness）来源适配器：纯日志驱动。
//!
//! 关于 hooks：DSH 0.2 线（桌面端内置运行时）确实带 `dsh-hook-protocol`
//! 以及 `dsh-hooks-codex` / `dsh-hooks-claude-code` 两个 bridge，但预设里默认
//! **没有挂载**，且它们面向的是「DSH 接受其它 agent 的 hook」，不是「把 DSH 的
//! 会话状态送给外部工具」。所以这里按读会话日志实现：DSH 侧零配置，装上就能看。
//!
//! DSH 把每个会话的完整事件流写在本地：
//! `$DSH_HOME/sessions/<项目>/<会话 id>/session.v{3,4}.jsonl.zstd`（append-only 多帧 zstd）。
//! 所以这里按「轮询 + 增量解码」读取，和 WorkBuddy 的审批日志是同一类做法。
//!
//! 三个必须处理的现实（都在真实数据上核实过）：
//!   * 日志是**多帧** zstd：只解第一帧只有 header，必须逐帧推进；
//!   * 会话目录里还有 `taskfold/*.jsonl`（agent-team 产物）与零字节 `session.lock`，
//!     只有「会话目录直接子文件且以 `session.` 开头」才是会话日志；
//!   * 大量会话的日志停在非终态（被 kill 掉的僵尸），必须靠 `session.lock` + 文件静默时长
//!     兜底判定「还在跑」，否则悬浮窗会挂满幽灵「进行中」。

use super::*;
use ruzstd::decoding::{BlockDecodingStrategy, FrameDecoder};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

/// 会话日志轮询间隔。DSH 的状态要跟着悬浮窗走，所以比审批日志快。
const SCAN_INTERVAL_MS: i64 = 1_500;
/// 没有活进程持锁、且日志静默超过这个时长，就判定会话已中断。
const STALE_AFTER_MS: i64 = 120_000;
/// 单行上限，挡住异常大的行把内存顶爆。
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

/// 增量多帧解码：按帧推进，只解新追加的帧。
#[derive(Default)]
struct FrameTail {
    offset: u64,
    carry: Vec<u8>,
}

impl FrameTail {
    /// 首次扫描用：直接落到文件末尾，历史一律不看。
    fn prime_at_end(&mut self, path: &Path) {
        self.offset = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        self.carry.clear();
    }

    fn pump(&mut self, path: &Path) -> Vec<String> {
        let Ok(mut file) = File::open(path) else {
            return Vec::new();
        };
        let Ok(len) = file.metadata().map(|m| m.len()) else {
            return Vec::new();
        };
        if len < self.offset {
            // 被截断或重写
            self.offset = 0;
            self.carry.clear();
        }
        if len == self.offset || file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut fresh = Vec::new();
        if file.read_to_end(&mut fresh).is_err() {
            return Vec::new();
        }
        let mut decoded = Vec::new();
        let mut input: &[u8] = &fresh;
        while !input.is_empty() {
            let mut dec = FrameDecoder::new();
            if dec.init(&mut input).is_err() {
                break; // 帧头不完整，等下一轮
            }
            match dec.decode_blocks(&mut input, BlockDecodingStrategy::All) {
                Ok(true) => {
                    let used = dec.bytes_read_from_source() as usize;
                    if used == 0 {
                        break;
                    }
                    let _ = dec.collect_to_writer(&mut decoded);
                    self.offset += used as u64;
                }
                // 帧体不完整：整帧丢弃，offset 不动，下一轮重来
                _ => break,
            }
        }
        self.carry.extend_from_slice(&decoded);
        let mut lines = Vec::new();
        let mut start = 0usize;
        for (i, byte) in self.carry.iter().enumerate() {
            if *byte == b'\n' {
                if i > start && i - start <= MAX_LINE_BYTES {
                    lines.push(String::from_utf8_lossy(&self.carry[start..i]).into_owned());
                }
                start = i + 1;
            }
        }
        self.carry.drain(..start);
        lines
    }
}

/// 单个会话的解析状态。
#[derive(Default)]
struct DshSession {
    id: String,
    cwd: String,
    title: String,
    /// 当前轮次（`turn/start` 给出），用来做 hub 的 roundId 隔离
    round: String,
    /// 尚未解除的审批等待项 id
    pending_approval: Option<String>,
    /// 已经就「僵尸」补发过结束事件，避免重复补
    reported_aborted: bool,
    /// 已经回扫过历史找标题，不再重试
    title_recovered: bool,
}

/// 轮询状态：每个日志的偏移、每会话的解析状态、节流与首次扫描标记。
pub struct DshWatch {
    tails: HashMap<PathBuf, FrameTail>,
    sessions: HashMap<PathBuf, DshSession>,
    /// 上次扫描的根目录。换路径＝换了一份数据源，必须重走首扫。
    root: PathBuf,
    pub primed: bool,
    pub last_scan: i64,
    /// 静默多久算中断。测试可覆写以绕开真实时长。
    pub stale_after_ms: i64,
    event_count: u64,
}

impl Default for DshWatch {
    fn default() -> Self {
        Self {
            tails: HashMap::new(),
            sessions: HashMap::new(),
            root: PathBuf::new(),
            primed: false,
            last_scan: 0,
            stale_after_ms: STALE_AFTER_MS,
            event_count: 0,
        }
    }
}

/// 只解第一帧拿会话身份（id / cwd / 标题）。
///
/// 「不恢复历史会话」的同时，仍然要知道这个会话是谁——否则会话稍后恢复运行时
/// 事件里没有 cwd，悬浮窗就只剩一个没有项目名的条目。
fn read_identity(path: &Path) -> Option<Value> {
    let prefix = decode_prefix(path, 64 * 1024);
    serde_json::from_str::<Value>(prefix.lines().next()?).ok()
}

/// 有界地解一段文件开头（最多 `limit` 字节压缩输入），返回解出来的文本。
///
/// 帧是顺序追加的，所以取开头一段就能覆盖会话早期的事件；这样既不必解全份历史，
/// 也不会因为会话很长而变慢。
fn decode_prefix(path: &Path, limit: usize) -> String {
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    let mut head = vec![0u8; limit];
    let Ok(read) = file.read(&mut head) else {
        return String::new();
    };
    head.truncate(read);
    let mut decoded = Vec::new();
    let mut input: &[u8] = &head;
    while !input.is_empty() {
        let mut dec = FrameDecoder::new();
        if dec.init(&mut input).is_err() {
            break;
        }
        match dec.decode_blocks(&mut input, BlockDecodingStrategy::All) {
            Ok(true) => {
                if dec.collect_to_writer(&mut decoded).is_err() {
                    break;
                }
            }
            _ => break,
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// 标题只在会话早期发一次，而首扫跳过了历史。等这个会话真正开始活动时，
/// 再回扫开头把它补上——否则卡片没有标题，只能退回显示项目名。
fn recover_title(path: &Path) -> Option<String> {
    decode_prefix(path, 256 * 1024)
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|ev| text(&ev["type"]) == "session/title")
        .map(|ev| text(&ev["data"]["title"]))
        .filter(|title| !title.is_empty())
}

fn session_log(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // 只认会话目录的直接子文件：taskfold/*.jsonl 是 agent-team 产物，不能当会话。
        if name.starts_with("session.")
            && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zstd"))
        {
            return Some(entry.path());
        }
    }
    None
}

fn collect_sessions(root: &Path, out: &mut Vec<(PathBuf, PathBuf)>) {
    let Ok(projects) = std::fs::read_dir(root.join("sessions")) else {
        return;
    };
    for project in projects.flatten() {
        let Ok(dirs) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for dir in dirs.flatten() {
            let session_dir = dir.path();
            if !session_dir.is_dir() {
                continue;
            }
            if let Some(log) = session_log(&session_dir) {
                out.push((log, session_dir));
            }
        }
    }
}

/// `session.lock` 是零字节 flock 文件：拿不到共享锁说明有活的 dsh 进程持有它。
fn session_live(session_dir: &Path) -> bool {
    let Ok(file) = File::open(session_dir.join("session.lock")) else {
        return false;
    };
    match file.try_lock_shared() {
        Ok(()) => {
            let _ = file.unlock();
            false
        }
        Err(std::fs::TryLockError::WouldBlock) => true,
        Err(std::fs::TryLockError::Error(_)) => false,
    }
}

/// 日志静默时长（毫秒）。
fn silence_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Collector {
    pub fn poll_dsh(&mut self) -> Result<(), String> {
        let Some(root) = self.paths("dsh").into_iter().next() else {
            self.hub.health("dsh", "unavailable", "未配置 DSH 数据目录");
            return Ok(());
        };
        if !root.join("sessions").is_dir() {
            self.dsh = DshWatch::default();
            self.hub.health(
                "dsh",
                "unavailable",
                "未检测到 DSH 会话目录（先运行一次 dsh）",
            );
            return Ok(());
        }

        // 换路径＝换了一份数据源：必须重走首扫，否则新根目录下**已有**的历史会话
        // 会被当成「首扫之后新出现的日志」全量恢复，一次刷出几百个历史会话。
        if self.dsh.root != root {
            if !self.dsh.root.as_os_str().is_empty() {
                self.dsh = DshWatch::default();
            }
            self.dsh.root = root.clone();
        }

        let time = now();
        if self.dsh.primed && time - self.dsh.last_scan < SCAN_INTERVAL_MS {
            return Ok(());
        }
        self.dsh.last_scan = time;

        let mut found = Vec::new();
        collect_sessions(&root, &mut found);
        for (log, dir) in found {
            let live = session_live(&dir);
            // 首次见到这个日志文件时登记进度。
            //   * 首次扫描（primed=false）：历史一律不看，只解第一帧记住身份；
            //     但正在跑的会话要折叠历史，把当前状态还原出来。
            //   * 首扫之后才出现的日志：内容对我们全是新的，从头读到尾。
            if !self.dsh.tails.contains_key(&log) {
                let mut tail = FrameTail::default();
                let mut state = DshSession {
                    id: dir
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    ..Default::default()
                };
                if !self.dsh.primed {
                    if let Some(identity) = read_identity(&log) {
                        let id = text(&identity["id"]);
                        if !id.is_empty() {
                            state.id = id;
                        }
                        state.cwd = text(&identity["cwd"]);
                    }
                    if !live {
                        tail.prime_at_end(&log);
                    }
                }
                self.dsh.tails.insert(log.clone(), tail);
                self.dsh.sessions.insert(log.clone(), state);
            }
            let lines = match self.dsh.tails.get_mut(&log) {
                Some(tail) => tail.pump(&log),
                None => continue,
            };
            // 把会话状态取出来再折叠：ingest_dsh_line 需要 &mut self（写 hub），
            // 不能和 sessions 的可变借用同时存在。
            let mut state = self.dsh.sessions.remove(&log).unwrap_or_default();
            for line in &lines {
                self.ingest_dsh_line(line, &mut state, time);
            }
            // 首扫跳过历史后，标题还得补：它只在会话早期发过一次。
            // 只对已经出现在悬浮窗里的会话回扫，避免为几百个历史会话白扫一遍。
            if !state.title_recovered
                && state.title.is_empty()
                && self.hub.sessions.contains_key(&format!("dsh:{}", state.id))
            {
                state.title_recovered = true;
                if let Some(title) = recover_title(&log) {
                    state.title = title;
                    self.emit_state(&state, json!({"type":"title"}), time);
                }
            }
            if !live && silence_ms(&log) > self.dsh.stale_after_ms {
                self.abort_dangling(&mut state, time);
            }
            self.dsh.sessions.insert(log.clone(), state);
        }
        // 会话被删除后清掉对应的增量状态
        self.dsh.tails.retain(|path, _| path.exists());
        self.dsh.sessions.retain(|path, _| path.exists());
        self.dsh.primed = true;

        self.hub.health(
            "dsh",
            "ok",
            if self.dsh.event_count == 0 {
                "等待新的 DSH 会话事件（不恢复历史会话）"
            } else {
                "已连接 DSH 会话日志"
            },
        );
        Ok(())
    }

    /// 非终态、又没活进程持锁、日志也停了：按中断收尾，避免幽灵「进行中」。
    fn abort_dangling(&mut self, state: &mut DshSession, time: i64) {
        if state.reported_aborted || state.id.is_empty() {
            return;
        }
        let Some(existing) = self.hub.sessions.get(&format!("dsh:{}", state.id)) else {
            return;
        };
        if crate::hub::terminal(&text(&existing["status"])) {
            return;
        }
        state.reported_aborted = true;
        let round = state.round.clone();
        self.emit_state(
            state,
            json!({"type":"end","roundId":round,"status":"aborted","endedBy":"dsh:interrupted"}),
            time,
        );
    }

    fn emit_state(&mut self, state: &DshSession, mut ev: Value, ts: i64) {
        ev["source"] = json!("dsh");
        ev["sessionId"] = json!(state.id);
        ev["ts"] = json!(ts);
        if !state.cwd.is_empty() {
            ev["cwd"] = json!(state.cwd);
        }
        if !state.title.is_empty() {
            ev["title"] = json!(state.title);
        }
        self.hub.ingest(ev);
    }

    /// 把一条 DSH 会话事件折成 hub 的通用事件。
    fn ingest_dsh_line(&mut self, line: &str, state: &mut DshSession, time: i64) {
        let Ok(ev) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let kind = text(&ev["type"]);
        let data = &ev["data"];
        let ts = ev["time"].as_i64().unwrap_or(time);
        match kind.as_str() {
            // 头部只提供身份：会话名、工作目录，不改变状态。
            "session" => {
                let id = text(&ev["id"]);
                if !id.is_empty() {
                    state.id = id;
                }
                state.cwd = text(&ev["cwd"]);
                let at = ev["createdAt"].as_i64().unwrap_or(ts);
                self.emit_state(state, json!({"type":"identity"}), at);
            }
            "session/title" => {
                let title = text(&data["title"]);
                if !title.is_empty() {
                    state.title = title;
                    self.emit_state(state, json!({"type":"title"}), ts);
                }
            }
            "turn/start" => {
                state.round = format!("turn-{}", data["turn"].as_i64().unwrap_or(0));
                state.pending_approval = None;
                state.reported_aborted = false;
                let round = state.round.clone();
                self.emit_state(state, json!({"type":"start","roundId":round}), ts);
                self.dsh.event_count += 1;
            }
            "step/start" => {
                if !state.round.is_empty() {
                    let step = data["step"].as_i64().unwrap_or(0);
                    let round = state.round.clone();
                    self.emit_state(
                        state,
                        json!({"type":"step","roundId":round,"eventId":format!("step-{step}"),"label":format!("第 {step} 步")}),
                        ts,
                    );
                    self.dsh.event_count += 1;
                }
            }
            "tool/call" => {
                if !state.round.is_empty() {
                    let call = text(&data["callId"]);
                    let tool = text(&data["name"]);
                    let round = state.round.clone();
                    self.emit_state(
                        state,
                        json!({"type":"step","roundId":round,"eventId":call,"label":format!("调用工具 {tool}")}),
                        ts,
                    );
                    self.dsh.event_count += 1;
                }
            }
            // 等权限确认：悬浮窗「等待确认」的信号来源。
            "approval/asked" | "permission/asked" => {
                let id = format!("approval-{}", ev["seq"].as_i64().unwrap_or(0));
                let detail = text(&data["kind"]);
                state.pending_approval = Some(id.clone());
                let round = state.round.clone();
                self.emit_state(
                    state,
                    json!({"type":"wait","roundId":round,"callId":id,"tool":"approval",
                           "text":if detail.is_empty(){"等待权限确认".to_owned()}else{detail}}),
                    ts,
                );
                self.dsh.event_count += 1;
            }
            "approval/decided" | "approval/settled" | "authorization/settled" => {
                if let Some(id) = state.pending_approval.take() {
                    let round = state.round.clone();
                    self.emit_state(
                        state,
                        json!({"type":"resolve","roundId":round,"callId":id}),
                        ts,
                    );
                    self.dsh.event_count += 1;
                }
            }
            "turn/end" => {
                let status = match text(&data["reason"]["kind"]).as_str() {
                    "completed" => "done",
                    "error" => "error",
                    _ => "aborted",
                };
                state.pending_approval = None;
                let round = state.round.clone();
                self.emit_state(state, json!({"type":"end","roundId":round,"status":status}), ts);
                self.dsh.event_count += 1;
            }
            "session/disposed" | "agent/disposed" => {
                state.pending_approval = None;
                state.reported_aborted = true;
                let round = state.round.clone();
                self.emit_state(
                    state,
                    json!({"type":"end","roundId":round,"status":"aborted","endedBy":"dsh:disposed"}),
                    ts,
                );
                self.dsh.event_count += 1;
            }
            // 其余事件（流式分片、请求头、compaction、未识别的新事件）一律不影响状态。
            _ => {}
        }
    }
}
