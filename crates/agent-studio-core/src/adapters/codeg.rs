//! Webhook-only lifecycle. No periodic conversation/database snapshot scans.
//! Credentials at registration; keyed session metadata only after an event.
use super::*;
use crate::{merge, question, questions};
use std::time::{Duration, Instant};
pub const CODEG_EVENTS: [&str; 5] = [
    "user_prompt_sent",
    "question_request",
    "permission_request",
    "turn_complete",
    "error",
];
#[derive(Default)]
pub struct CodegHooks {
    pub url: String,
    pub registered: bool,
    pub next_attempt: Option<Instant>,
    auth: Option<(u16, String)>,
    connections: HashMap<String, String>,
    ignored_connections: std::collections::HashSet<String>,
    sequence: u64,
}
pub fn merge_codeg_webhooks(
    existing: &Value,
    owned: &[String],
    url: &str,
) -> Result<Value, String> {
    let list = existing
        .as_array()
        .ok_or("Codeg Webhook 配置无效，未覆盖")?;
    if list
        .iter()
        .any(|w| !w["url"].is_string() || !w["enabled"].is_boolean())
    {
        return Err("Codeg Webhook 配置无效，未覆盖".into());
    }
    let mut next: Vec<_> = list
        .iter()
        .filter(|w| w["url"] != url && !owned.contains(&text(&w["url"])))
        .cloned()
        .collect();
    if !url.is_empty() {
        next.push(json!({"url":url,"enabled":true}));
    }
    Ok(json!(next))
}
fn owned_urls(saved: &Value) -> Result<Vec<String>, String> {
    saved["owned"].as_array().ok_or("Codeg 注册记录无效")?
        .iter().map(|v| v.as_str().map(str::to_owned).ok_or_else(|| "Codeg 注册记录无效".to_string())).collect()
}
fn post(auth: &(u16, String), method: &str, body: Value) -> Result<Value, String> {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(1500))
        .build()
        .post(&format!("http://127.0.0.1:{}/api/{method}", auth.0))
        .set("Authorization", &format!("Bearer {}", auth.1))
        .send_json(body)
        .map_err(|_| "Codeg Web Service 不可用")?
        .into_json()
        .map_err(|_| "Codeg API 返回无效".to_string())
}
impl Collector {
    fn codeg_credentials(&self) -> Result<(u16, String), String> {
        let db = open(&self.paths("codeg"))?;
        let rows = query(&db,"SELECT key,value FROM app_metadata WHERE key IN ('web_service_port','web_service_token')")?;
        let value = |k: &str| {
            rows.iter()
                .find(|r| r["key"] == k)
                .map(|r| text(&r["value"]))
                .unwrap_or_default()
        };
        let port = value("web_service_port")
            .parse::<u16>()
            .ok()
            .filter(|p| *p > 0)
            .unwrap_or(3080);
        let token = value("web_service_token");
        if token.is_empty() {
            return Err("请启用 Codeg Web Service".into());
        }
        Ok((port, token))
    }
    pub fn configure_codeg_webhook(&mut self, url: String) {
        self.codeg.url = url;
        self.codeg.registered = false;
        self.codeg.next_attempt = None;
    }
    pub fn maintain_codeg_webhook(&mut self) -> Result<(), String> {
        if self.codeg.url.is_empty() {
            self.hub
                .health("codeg", "partial", "Webhook 接收入口尚未启动");
            return Ok(());
        }
        if self.codeg.registered
            || self
                .codeg
                .next_attempt
                .is_some_and(|at| Instant::now() < at)
        {
            return Ok(());
        }
        self.codeg.next_attempt = Some(Instant::now() + Duration::from_secs(60));
        let enabled = self.settings["sources"]["codeg"]["enabled"] == true && self.integration_automatic("codeg");
        let file = self.home.join(".agent-studio/codeg-webhook-native.json");
        let saved: Value = match std::fs::read(&file) {
            Ok(b) => serde_json::from_slice(&b).map_err(|_| "Codeg 注册记录无效，未覆盖")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({"owned":[]}),
            Err(_) => return Err("Codeg 注册记录不可读".into()),
        };
        let mut owned = owned_urls(&saved)?;
        if !enabled && owned.is_empty() {
            self.codeg.registered = true;
            return Ok(());
        }
        let auth = self.codeg_credentials()?;
        let existing = post(&auth, "get_chat_event_webhooks", json!({}))?;
        let url = if enabled {
            self.codeg.url.clone()
        } else {
            String::new()
        };
        let next = merge_codeg_webhooks(&existing, &owned, &url)?;
        if enabled {
            let filter = post(&auth, "get_chat_event_filter", json!({}))?;
            let mut current: Vec<Value> = if filter.is_null() {
                CODEG_EVENTS[1..].iter().map(|e| json!(e)).collect()
            } else {
                filter
                    .as_array()
                    .filter(|a| a.iter().all(Value::is_string))
                    .cloned()
                    .ok_or("Codeg 事件配置无效")?
            };
            if CODEG_EVENTS.iter().any(|e| !current.contains(&json!(e))) {
                let channels = post(&auth, "list_chat_channels", json!({}))?;
                if channels
                    .as_array()
                    .ok_or("Codeg 推送配置无效")?
                    .iter()
                    .any(|c| c["enabled"] == true)
                    || next
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|w| w["url"] != url && w["enabled"] == true)
                {
                    return Err("Codeg 全局开关影响其他推送目标；请先在 Codeg 启用五类事件".into());
                }
                for e in CODEG_EVENTS {
                    if !current.contains(&json!(e)) {
                        current.push(json!(e));
                    }
                }
                post(&auth, "set_chat_event_filter", json!({"filter":current}))?;
            }
        }
        if !url.is_empty() && !owned.contains(&url) {
            owned.push(url.clone());
        }
        // Persist ownership before sending; uncertain network responses are safe to retry.
        atomic_json(&file, &json!({"owned":owned}))?;
        if existing != next {
            post(&auth, "set_chat_event_webhooks", json!({"webhooks":next}))?;
        }
        let verified = post(&auth, "get_chat_event_webhooks", json!({}))?;
        if verified != next { return Err("Codeg 未确认 Webhook 配置，请重试".into()); }
        atomic_json(
            &file,
            &json!({"owned":if url.is_empty(){vec![]}else{vec![url]}}),
        )?;
        self.codeg.auth = Some(auth);
        self.codeg.registered = true;
        self.hub.health(
            "codeg",
            if enabled { "ok" } else { "disabled" },
            if enabled {
                "Webhook 已注册，等待 Codeg 事件（不扫描会话）"
            } else {
                "已关闭监听"
            },
        );
        Ok(())
    }
    pub fn inspect_codeg_webhook(&self) -> Result<(&'static str, String), String> {
        let file = self.home.join(".agent-studio/codeg-webhook-native.json");
        let owned = match std::fs::read(file) {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).map_err(|_| "Codeg 注册记录无效")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({"owned":[]}),
            Err(e) => return Err(e.to_string()),
        };
        let owned = owned_urls(&owned)?;
        let pending = (!self.integration_automatic("codeg") || self.settings["sources"]["codeg"]["enabled"] != true) && !owned.is_empty();
        let result = self.codeg_credentials().and_then(|auth| post(&auth, "get_chat_event_webhooks", json!({})));
        match result {
            Err(e) => Ok((if pending { "pending" } else { "unavailable" }, if pending { format!("待注销；{e}，请启动 Codeg 后重试") } else {e})),
            Ok(value) => {
                let list = value.as_array().ok_or("Codeg Webhook 配置无效")?;
                let found = list.iter().any(|v| v["url"] == self.codeg.url && v["enabled"] == true);
                if pending { Ok(("pending", "接入已暂停；待重试注销".into())) }
                else if found {
                    let filter = post(&self.codeg_credentials()?, "get_chat_event_filter", json!({}))?;
                    if !CODEG_EVENTS.iter().all(|e| filter.as_array().is_some_and(|a|a.contains(&json!(e)))) { Ok(("partial", "Webhook 已注册，但事件开关不完整，请修复".into())) }
                    else { Ok(("installed", "Webhook 已注册".into())) }
                }
                else { Ok(("not_installed", "Webhook 未注册；注册需要开启监听".into())) }
            }
        }
    }
    pub fn stop_codeg_webhook(&mut self) {
        self.settings["sources"]["codeg"]["enabled"] = json!(false);
        self.codeg.registered = false;
        self.codeg.next_attempt = None;
        let _ = self.maintain_codeg_webhook();
    }
    fn codeg_metadata(&self, sid: &str) -> Result<Value, String> {
        let db = open(&self.paths("codeg"))?;
        // Parameter binding: the callback never supplies SQL identifiers or SQL text.
        let table = if db.prepare("SELECT id FROM conversation LIMIT 0").is_ok() {
            "conversation"
        } else {
            "conversations"
        };
        let mut st = db
            .prepare(&format!("SELECT * FROM {table} WHERE id=?1"))
            .map_err(|_| "Codeg 会话表不可读")?;
        let names: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
        let raw = st
            .query_row([sid], |r| {
                let mut out = serde_json::Map::new();
                for (i, n) in names.iter().enumerate() {
                    let v = match r.get_ref(i)? {
                        ValueRef::Text(b) => json!(String::from_utf8_lossy(b)),
                        ValueRef::Integer(n) => json!(n),
                        _ => Value::Null,
                    };
                    out.insert(n.clone(), v);
                }
                Ok(Value::Object(out))
            })
            .map_err(|_| "Codeg 会话未找到")?;
        let get = |keys: &[&str]| {
            keys.iter()
                .map(|k| raw[*k].clone())
                .find(|v| !v.is_null() && !text(v).is_empty())
                .unwrap_or(Value::Null)
        };
        let mut cwd = get(&["origin_cwd", "cwd", "workspace"]);
        if text(&cwd).is_empty() {
            if let Ok(p) = db.query_row(
                "SELECT path FROM folder WHERE id=?1",
                [text(&raw["folder_id"])],
                |r| r.get::<_, String>(0),
            ) {
                cwd = json!(p);
            }
        }
        Ok(
            json!({"cwd":cwd,"title":raw["title"],"agentType":get(&["agent_type","agent"]),"externalId":raw["external_id"],"folderId":raw["folder_id"],"isSubagent":!raw["parent_id"].is_null() || raw["kind"] == "delegate"}),
        )
    }
    pub fn ingest_codeg_hook(&mut self, p: &Value) -> bool {
        if self.settings["sources"]["codeg"]["enabled"] != true || p["source"] != "codeg" {
            return false;
        }
        let event = text(&p["event"]);
        let conn = text(&p["connection_id"]);
        if !CODEG_EVENTS.contains(&event.as_str()) || conn.trim().is_empty() || conn.len() > 256 {
            return false;
        }
        if self.codeg.ignored_connections.contains(&conn) {
            return true;
        }
        if self.codeg.auth.is_none() {
            self.codeg.auth = self.codeg_credentials().ok();
        }
        let snap = self
            .codeg
            .auth
            .as_ref()
            .and_then(|a| post(a, "acp_get_session_snapshot", json!({"connectionId":conn})).ok())
            .unwrap_or(Value::Null);
        let provisional = format!("connection:{conn}");
        let sid = if !snap["conversation_id"].is_null() {
            text(&snap["conversation_id"])
        } else {
            self.codeg
                .connections
                .get(&conn)
                .cloned()
                .unwrap_or(provisional.clone())
        };
        if sid != provisional {
            self.codeg.connections.insert(conn.clone(), sid.clone());
            self.hub.sessions.remove(&format!("codeg:{provisional}"));
        }
        if self.codeg.connections.len() > 512 {
            if let Some(k) = self.codeg.connections.keys().next().cloned() {
                self.codeg.connections.remove(&k);
            }
        }
        let meta = if sid != provisional {
            self.codeg_metadata(&sid).unwrap_or(json!({}))
        } else {
            json!({})
        };
        if meta["isSubagent"] == true {
            // Keep known children ignored during subsequent API/database outages.
            self.codeg.ignored_connections.insert(conn);
            self.hub.sessions.remove(&format!("codeg:{provisional}"));
            self.hub.sessions.remove(&format!("codeg:{sid}"));
            return true;
        }
        let ts = now();
        self.codeg.sequence += 1;
        let seq = self.codeg.sequence;
        let mut base = merge(meta, json!({"source":"codeg","sessionId":sid,"ts":ts}));
        if !snap["external_id"].is_null() {
            base["externalId"] = snap["external_id"].clone();
        }
        if !snap["folder_id"].is_null() {
            base["folderId"] = snap["folder_id"].clone();
        }
        let k = format!("codeg:{sid}");
        if event == "user_prompt_sent"
            || self
                .hub
                .sessions
                .get(&k)
                .is_none_or(|s| crate::hub::terminal(&text(&s["status"])))
        {
            let title = if text(&base["title"]).is_empty() {
                text(&p["body"])
            } else {
                text(&base["title"])
            };
            self.hub.ingest(merge(
                base.clone(),
                json!({"type":"start","roundId":format!("hook:{ts}:{seq}"),"title":title}),
            ));
        }
        if matches!(event.as_str(), "question_request" | "permission_request") {
            let ask = if !snap["pending_question"].is_null() {
                snap["pending_question"].clone()
            } else if !snap["pending_plan_approval"].is_null() {
                json!({"questions":[{"question":snap["pending_plan_approval"]["plan_markdown"],"options":[{"label":"批准"},{"label":"拒绝"}]}]})
            } else if !snap["pending_permission"].is_null() {
                let a = &snap["pending_permission"];
                json!({"questions":[{"question":a["tool_call"]["title"].as_str().unwrap_or("需要你的许可"),"options":a["options"].as_array().into_iter().flatten().map(|o|json!({"label":o["name"],"description":o["kind"]})).collect::<Vec<_>>()}]})
            } else {
                Value::Null
            };
            let pending = self.hub.sessions[&k]["pending"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for item in pending {
                self.hub.ingest(merge(
                    base.clone(),
                    json!({"type":"resolve","callId":item["id"]}),
                ));
            }
            let fields = p["fields"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|f| text(&f["value"]))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            let message = if !ask.is_null() {
                question(&ask)
            } else if !fields.is_empty() {
                fields
            } else {
                text(&p["body"])
            };
            let call = ask["question_id"]
                .as_str()
                .or(ask["request_id"].as_str())
                .map(str::to_owned)
                .unwrap_or(format!("codeg:{conn}:{seq}"));
            self.hub.ingest(merge(base,json!({"type":"wait","callId":call,"tool":if event=="question_request"{"ask"}else{"permission"},"text":message,"questions":questions(&ask)})));
        } else if matches!(event.as_str(), "turn_complete" | "error") {
            self.hub.ingest(merge(
                base,
                json!({"type":"end","status":if event=="error"{"error"}else{"done"}}),
            ));
        }
        self.hub.health(
            "codeg",
            "ok",
            "已收到 Codeg Webhook；回答后的状态等待下一条事件更新",
        );
        true
    }
}
