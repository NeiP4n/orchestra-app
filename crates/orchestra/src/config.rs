use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Endpoint {
    pub base: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub model: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub endpoints: Vec<Endpoint>,
}

pub fn path(home: &Path) -> PathBuf {
    home.join("config.json")
}

pub fn load(home: &Path) -> Config {
    std::fs::read_to_string(path(home)).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

pub fn save(home: &Path, config: &Config) -> std::io::Result<()> {
    std::fs::create_dir_all(home)?;
    std::fs::write(path(home), serde_json::to_string_pretty(config).expect("config always serializes"))
}

/// Environment variables override the saved file so a shell can point one run elsewhere.
pub fn resolve(saved: Config, env: impl Fn(&str) -> Option<String>) -> Config {
    let list = |name: &str| -> Vec<String> {
        env(name).map(|value| value.split(',').map(|part| part.trim().to_string()).collect()).unwrap_or_default()
    };
    let bases: Vec<String> = list("ORCHESTRA_BASE_URL").into_iter().filter(|base| !base.is_empty()).collect();
    if bases.is_empty() {
        return saved;
    }
    let (keys, models) = (list("ORCHESTRA_API_KEY"), list("ORCHESTRA_MODEL"));
    let pick = |values: &[String], index: usize| values.get(index).or_else(|| values.last()).filter(|value| !value.is_empty()).cloned();
    Config {
        endpoints: bases
            .iter()
            .enumerate()
            .map(|(index, base)| Endpoint {
                base: base.clone(),
                key: pick(&keys, index),
                model: pick(&models, index).unwrap_or_else(|| "gpt-4o-mini".into()),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string())
    }

    #[test]
    fn saved_config_is_used_when_the_environment_is_silent() {
        let saved = Config { endpoints: vec![Endpoint { base: "http://a".into(), key: None, model: "m".into() }] };
        assert_eq!(resolve(saved.clone(), env(&[])), saved);
    }

    #[test]
    fn environment_lists_override_and_share_the_last_value() {
        let config = resolve(Config::default(), env(&[("ORCHESTRA_BASE_URL", "http://a, http://b"), ("ORCHESTRA_API_KEY", "k1,k2"), ("ORCHESTRA_MODEL", "m")]));
        assert_eq!(config.endpoints.len(), 2);
        assert_eq!(config.endpoints[1].key.as_deref(), Some("k2"));
        assert_eq!(config.endpoints[1].model, "m");
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = std::env::temp_dir().join(format!("orchestra-config-{}", std::process::id()));
        let config = Config { endpoints: vec![Endpoint { base: "http://a".into(), key: Some("k".into()), model: "m".into() }] };
        save(&dir, &config).unwrap();
        assert_eq!(load(&dir), config);
    }
}
