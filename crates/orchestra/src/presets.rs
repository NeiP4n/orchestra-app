//! Well-known OpenAI-compatible services, so setup only needs a name and a key.
use serde_json::Value;

pub struct Preset {
    pub name: &'static str,
    pub base: &'static str,
    /// Where a person gets a free key.
    pub keys: &'static str,
}

pub const ALL: [Preset; 4] = [
    Preset { name: "gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", keys: "https://aistudio.google.com/apikey" },
    Preset { name: "groq", base: "https://api.groq.com/openai/v1", keys: "https://console.groq.com/keys" },
    Preset { name: "openrouter", base: "https://openrouter.ai/api/v1", keys: "https://openrouter.ai/keys" },
    Preset { name: "cerebras", base: "https://api.cerebras.ai/v1", keys: "https://cloud.cerebras.ai" },
];

pub fn find(name: &str) -> Option<&'static Preset> {
    ALL.iter().find(|preset| preset.name == name.trim().to_lowercase())
}

/// Reads ids out of a `/models` answer; some services prefix them with `models/`.
pub fn ids(answer: &Value) -> Vec<String> {
    answer["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| model["id"].as_str())
        .map(|id| id.strip_prefix("models/").unwrap_or(id).to_string())
        .collect()
}

/// Picks a sensible chat model from what the service really offers, never from a guess.
pub fn pick(preset: &str, ids: &[String]) -> Option<String> {
    let chat = |id: &&String| {
        !["embed", "image", "tts", "audio", "whisper", "guard", "vision-only", "live", "imagen", "veo", "moderation"]
            .iter()
            .any(|word| id.to_lowercase().contains(word))
    };
    let usable: Vec<&String> = ids.iter().filter(chat).collect();
    let by = |words: &[&str]| usable.iter().find(|id| words.iter().all(|word| id.to_lowercase().contains(word))).map(|id| id.to_string());
    match preset {
        "openrouter" => by(&[":free", "coder"]).or_else(|| by(&[":free", "llama"])).or_else(|| by(&[":free"])),
        "gemini" => usable.iter().find(|id| id.contains("flash") && !id.contains("lite")).map(|id| id.to_string()).or_else(|| by(&["flash"])),
        "groq" => by(&["llama-3.3-70b"]).or_else(|| by(&["gpt-oss"])),
        _ => usable.first().map(|id| id.to_string()),
    }
    .or_else(|| usable.first().map(|id| id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn strips_the_models_prefix_and_reads_the_data_array() {
        assert_eq!(ids(&json!({ "data": [{ "id": "models/gemini-x-flash" }, { "id": "b" }] })), ["gemini-x-flash", "b"]);
        assert!(ids(&json!({})).is_empty());
    }

    #[test]
    fn picks_free_coders_on_openrouter_and_skips_non_chat_models() {
        let ids = list(&["text-embedding-1", "a/llama-70b:free", "b/qwen-coder:free", "c/paid"]);
        assert_eq!(pick("openrouter", &ids).as_deref(), Some("b/qwen-coder:free"));
    }

    #[test]
    fn prefers_full_flash_over_lite_for_gemini_and_falls_back_to_anything_usable() {
        assert_eq!(pick("gemini", &list(&["gemini-9-flash-lite", "gemini-9-flash", "gemini-9-pro"])).as_deref(), Some("gemini-9-flash"));
        assert_eq!(pick("groq", &list(&["whisper-large", "some-model"])).as_deref(), Some("some-model"));
        assert_eq!(pick("groq", &[]), None);
    }
}
