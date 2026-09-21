use std::process::Command;
#[derive(Debug)]
enum SessionTarget {
    Link(url::Url),
    App(&'static str),
}
fn codebuddy_international(edition: Option<&str>) -> bool {
    !matches!(edition, Some("domestic" | "codebuddycn"))
}
fn codebuddy_bundle(edition: Option<&str>) -> &'static str {
    if codebuddy_international(edition) {
        "com.tencent.codebuddy"
    } else {
        "com.tencent.codebuddycn"
    }
}
fn app_for_scheme(scheme: &str) -> Option<(&'static str, &'static str)> {
    Some(match scheme {
        "workbuddy-ai" => ("WorkBuddy AI.app", "com.workbuddy.workbuddy-ai"),
        "workbuddy" => ("WorkBuddy.app", "com.tencent.workbuddy.mac"),
        "codebuddy" => ("CodeBuddy.app", "com.tencent.codebuddy"),
        "codebuddycn" => ("CodeBuddy CN.app", "com.tencent.codebuddycn"),
        _ => return None,
    })
}
fn session_target(url: &str) -> Result<SessionTarget, String> {
    if url.starts_with("/api/open-session?") {
        let parsed =
            url::Url::parse(&format!("http://localhost{url}")).map_err(|e| e.to_string())?;
        let sources: Vec<_> = parsed.query_pairs().filter(|(key, _)| key == "source").map(|(_, value)| value.into_owned()).collect();
        let edition = parsed
            .query_pairs()
            .find(|(key, _)| key == "edition")
            .map(|(_, value)| value.into_owned());
        return match sources.as_slice() {
            [source] if source == "codeg" => Ok(SessionTarget::App("app.codeg")),
            [source] if source == "codebuddy-ide" => {
                Ok(SessionTarget::App(codebuddy_bundle(edition.as_deref())))
            }
            _ => Err("不支持的应用".into()),
        };
    }
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    let supported = matches!(
        (parsed.scheme(), parsed.host_str()),
        ("codex", Some("threads"))
            | ("workbuddy", Some("chat"))
            | ("workbuddy-ai", Some("chat"))
            | ("codebuddy", Some("file"))
            | ("codebuddycn", Some("file"))
            | ("codeg", Some("session"))
    );
    // Older frontends emitted a bare file URL when a Hook reported cwd="/".
    // Activate the app rather than opening the filesystem root as a project.
    if matches!(parsed.scheme(), "codebuddy" | "codebuddycn") && parsed.host_str() == Some("file")
        && matches!(parsed.path(), "" | "/") && parsed.username().is_empty() && parsed.password().is_none()
        && parsed.query().is_none() && parsed.fragment().is_none() {
        return Ok(SessionTarget::App(if parsed.scheme() == "codebuddy" {
            "com.tencent.codebuddy"
        } else {
            "com.tencent.codebuddycn"
        }));
    }
    if !supported
        || parsed.path().len() < 2
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("不支持的会话链接".into());
    }
    Ok(SessionTarget::Link(parsed))
}
#[tauri::command]
pub async fn open_session_url(url: String) -> Result<(), String> {
    let target = session_target(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut c = Command::new("/usr/bin/open");
            if let SessionTarget::Link(target) = target {
                if let Some((app, bundle)) = app_for_scheme(target.scheme()) {
                    // URL scheme registration can be missing even while the app
                    // is installed/running. Deliver the deep link to the app itself.
                    let installed = [
                        Some(std::path::PathBuf::from(format!("/Applications/{app}"))),
                        std::env::var_os("HOME").map(|home| {
                            std::path::PathBuf::from(home).join("Applications").join(app)
                        }),
                    ]
                    .into_iter()
                    .flatten()
                    .find(|path| path.join("Contents/Info.plist").is_file());
                    if let Some(path) = installed {
                        c.arg("-a").arg(path);
                    } else {
                        c.args(["-b", bundle]);
                    }
                }
                c.arg(target.as_str());
            } else if let SessionTarget::App(bundle) = target {
                c.args(["-b", bundle]);
            }
            c
        };
        #[cfg(target_os = "windows")]
        let mut command = {
            let SessionTarget::Link(target) = target else {
                return Err("当前平台尚不支持仅唤起应用".into());
            };
            let mut c = Command::new("rundll32.exe");
            c.args(["url.dll,FileProtocolHandler", target.as_str()]);
            c
        };
        #[cfg(target_os = "linux")]
        let mut command = {
            let SessionTarget::Link(target) = target else {
                return Err("当前平台尚不支持仅唤起应用".into());
            };
            let mut c = Command::new("xdg-open");
            c.arg(target.as_str());
            c
        };
        let output = command.output().map_err(|e| format!("无法调用系统打开服务：{e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            let detail = String::from_utf8_lossy(&output.stderr);
            eprintln!("Agent session open failed: {}", detail.trim());
            Err(if detail.contains("-10814") || detail.contains("Unable to find application") {
                "系统未找到应用或链接处理程序，请确认应用位置后重试".into()
            } else {
                "未能唤起目标 Agent，请打开应用后重试".into()
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn link(value: &str) -> url::Url {
        match session_target(value).unwrap() {
            SessionTarget::Link(url) => url,
            _ => panic!("expected session link"),
        }
    }
    #[test]
    fn codebuddy_missing_workspace_activates_app_without_opening_root() {
        for value in ["/api/open-session?source=codebuddy-ide&edition=domestic", "codebuddycn://file/", "codebuddycn://file"] {
            assert!(matches!(session_target(value).unwrap(), SessionTarget::App("com.tencent.codebuddycn")));
        }
        for value in ["/api/open-session?source=codebuddy-ide", "/api/open-session?source=codebuddy-ide&edition=international", "codebuddy://file/", "codebuddy://file"] {
            assert!(matches!(session_target(value).unwrap(), SessionTarget::App("com.tencent.codebuddy")));
        }
        assert_eq!(link("codebuddycn://file/Users/apple/project").path(), "/Users/apple/project");
        assert_eq!(link("codebuddy://file/Users/apple/project").path(), "/Users/apple/project");
        for value in ["codebuddycn://user@file/", "codebuddy://user@file/", "codebuddycn://other/path", "/api/open-session?source=other", "/api/open-session?source=codeg&source=codebuddy-ide"] {
            assert!(session_target(value).is_err());
        }
    }
    #[test]
    fn codeg_links_target_the_requested_session() {
        let target = link("codeg://session/214");
        assert_eq!(target.as_str(), "codeg://session/214");
        let encoded = link("codeg://session/task%2Fa%20%3F%23");
        assert_eq!(encoded.path(), "/task%2Fa%20%3F%23");
        for invalid in ["codeg://session/", "codeg://other/214", "codeg://user@session/214"] {
            assert!(session_target(invalid).is_err());
        }
    }
    #[test]
    fn workbuddy_editions_use_distinct_url_schemes() {
        let domestic = link("workbuddy://chat/abc");
        assert_eq!(domestic.scheme(), "workbuddy");
        let international = link("workbuddy-ai://chat/abc");
        assert_eq!(international.scheme(), "workbuddy-ai");
        assert!(session_target("workbuddy://other/abc").is_err());
    }
}
