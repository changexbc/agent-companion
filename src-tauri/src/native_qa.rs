//! Opt-in diagnostics of this application's own WebViews using an isolated home.
use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2_app_kit::NSImage;
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::WKWebView;
use tauri::Manager;
pub fn schedule(app: &tauri::AppHandle) {
    let (Some(out), Some(_)) = (
        std::env::var_os("AGENT_COMPANION_QA"),
        std::env::var_os("AGENT_STUDIO_HOME"),
    ) else {
        return;
    };
    let out = std::path::PathBuf::from(out);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(12));
        let _ = agent_studio_desktop::open(&app, "settings");
        std::thread::sleep(std::time::Duration::from_secs(4));
        if let Some(window) = app.get_webview_window("agent-studio-settings") {
            let _ = window.eval("document.querySelector('.cinema-gallery')?.scrollIntoView({block:'center'})");
        }
        if std::env::var_os("AGENT_COMPANION_QA_DOCK").is_some() {
            if let Some(window) = app.get_webview_window("agent-studio-rail") {
                let _ = window.eval(include_str!("../../scripts/native-dock-probe.js"));
            }
            std::thread::sleep(std::time::Duration::from_secs(16));
        }
        std::thread::sleep(std::time::Duration::from_millis(600));
        let _ = std::fs::create_dir_all(&out);
        let _ = std::fs::write(out.join("native-hit-regions.json"),
            serde_json::to_vec(&agent_studio_desktop::hit_regions_snapshot(&app)).unwrap());
        let labels: Vec<_> = app.webview_windows().keys().cloned().collect();
        let _ = std::fs::write(
            out.join("windows.json"),
            serde_json::to_vec(&labels).unwrap(),
        );
        let unsupported = agent_studio_desktop::open(&app, "office").err();
        let _ = std::fs::write(
            out.join("unsupported-view.json"),
            serde_json::to_vec(&unsupported).unwrap(),
        );
        for (label, window) in app.webview_windows() {
            let dir = out.join(label);
            let _ = window.with_webview(move |platform| {
                let view = unsafe { &*(platform.inner() as *const WKWebView) };
                let _ = std::fs::create_dir_all(&dir);
                let image_path = dir.join("window.tiff");
                let capture = RcBlock::new(move |image: *mut NSImage, _: *mut NSError| {
                    if let Some(image) = unsafe { image.as_ref() } {
                        if let Some(data) = image.TIFFRepresentation() { let _ = std::fs::write(&image_path, data.to_vec()); }
                    }
                });
                unsafe { view.takeSnapshotWithConfiguration_completionHandler(None, &capture); }
                let report = RcBlock::new(move |value: *mut AnyObject, _: *mut NSError| {
                    if !value.is_null() {
                        let text = unsafe { &*(value as *const NSString) }.to_string();
                        let _ = std::fs::write(dir.join("report.json"), text);
                    }
                });
                let script = NSString::from_str(r#"JSON.stringify({dock:window.__companionDockQA??null,title:document.title,connection:document.querySelector('.desktop-connection')?.dataset.connection,avatars:document.querySelectorAll('.desktop-avatar').length,portraitStyles:[...document.querySelectorAll('.desktop-portrait')].map(e=>e.dataset.style),selectedAvatarStyle:document.querySelector('.styles button[aria-pressed=true]')?.dataset.style,critterExpressions:[...document.querySelectorAll('.desktop-portrait[data-style=critters]')].map(e=>({state:e.dataset.state,eyes:!!e.querySelector('.critter-eyes')?.children.length,mouth:!!e.querySelector('.critter-mouth')?.children.length})),cinemaGallery:[...document.querySelectorAll('.cinema-gallery span')].map(e=>e.textContent),cinemaImages:[...document.querySelectorAll('.cinema-portrait')].map(e=>({href:e.getAttribute('href'),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})),critterIdsUnique:(()=>{const ids=[...document.querySelectorAll('[id^=critter-]')].map(e=>e.id);return new Set(ids).size===ids.length})(),critterReferencesValid:[...document.querySelectorAll('.desktop-portrait[data-style=critters] [href],.desktop-portrait[data-style=critters] [clip-path]')].every(e=>{const ref=e.getAttribute('href')||e.getAttribute('clip-path');const id=ref.startsWith('#')?ref.slice(1):ref.match(/url\(#([^)]+)\)/)?.[1];return !id||!!e.closest('.desktop-portrait').querySelector(`[id="${id}"]`)}),wait:document.querySelectorAll('.desktop-avatar[data-status=wait]').length,text:document.body.innerText,menu:[...document.querySelectorAll('[role=menuitem]')].map(e=>e.textContent),settingsReady:document.querySelector('fieldset')?.disabled===false,resources:performance.getEntriesByType('resource').map(r=>r.name),width:innerWidth,height:innerHeight,welcome:{phase:document.querySelector('#desktop-rail')?.dataset.welcome??null,time:document.querySelector('#desktop-rail')?.dataset.welcomeTime??null,blocking:document.querySelector('#desktop-rail')?.classList.contains('welcome-blocking')??null,running:document.querySelector('#desktop-rail')?.classList.contains('welcome-running')??null,panels:document.querySelectorAll('.desktop-welcome').length},reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,hidden:document.hidden,visibility:document.visibilityState,textContent:document.body.textContent.replace(/\s+/g,' ').trim().slice(0,120)})"#);
                unsafe { view.evaluateJavaScript_completionHandler(&script, Some(&report)); }
            });
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
        app.exit(0);
    });
}
