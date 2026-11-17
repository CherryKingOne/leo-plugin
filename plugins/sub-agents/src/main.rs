use std::sync::Arc;

use leo_plugin_sdk::runtime;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    runtime::serve(Arc::new(leo_plugin_sub_agents::SubAgentsPlugin)).await
}