use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};

use uuid::Uuid;

pub fn run_id() -> Uuid {
    std::env::var("KLADDE_QA_RUN")
        .expect("Test run UUID")
        .parse()
        .expect("Test run UUID")
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    let run = run_id();
    let stage = std::env::var("KLADDE_QA_STAGE").expect("Test stage");
    let start = std::time::Instant::now();
    let settings = serde_json::json!({"stage":stage,"run":run});

    Builder::new("native-acceptance")
        .js_init_script(format!("window.__KLADDE_TEST__={settings};"))
        .on_navigation(move |view,url| {
            if url.path()!="/__kladde_acceptance__" {return true}
            let value=url.query_pairs().find(|(k,_)|k=="result").map(|(_,v)|v.to_string()).unwrap_or_default();

            if value.len()>3000 {return false}
            let result=serde_json::json!({"stage":stage,"result":value,"native_ms":start.elapsed().as_millis()});
            let directory=view.app_handle().path().app_data_dir().expect("Test output directory").join("acceptance").join(run.to_string());

            std::fs::create_dir_all(&directory).expect("Test directory");
            let temp=directory.join("result.tmp");

            std::fs::write(&temp,result.to_string()).expect("Test result");
            std::fs::rename(temp,directory.join("result.json")).expect("Test result");

            false
        }).build()
}
