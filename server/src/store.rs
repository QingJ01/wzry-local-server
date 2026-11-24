use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Observation {
    #[serde(rename = "recordedAtUnixMs")]
    pub recorded_at_unix_ms: u64,
    pub channel: &'static str,
    pub source: Option<String>,
    #[serde(rename = "methodId")]
    pub method_id: Option<u64>,
    pub command: Option<u16>,
    pub sequence: Option<u16>,
    pub bytes: usize,
    pub status: u16,
}

impl Observation {
    pub fn now(channel: &'static str) -> Self {
        Self {
            channel,
            source: None,
            method_id: None,
            command: None,
            sequence: None,
            bytes: 0,
            status: 200,
            recorded_at_unix_ms: unix_time_ms(),
        }
    }
}

pub trait Store: Send + Sync {
    fn add_observation(&self, observation: Observation);
    fn observations(&self) -> Vec<Observation>;
    fn observation_count(&self) -> usize;
    fn invalid_frames(&self) -> usize;
    fn add_invalid_frame(&self);
}

#[derive(Default)]
pub struct MemoryStore {
    observations: Mutex<Vec<Observation>>,
    invalid_frames: Mutex<usize>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn recent_observations(&self, limit: usize) -> Vec<Observation> {
        let observations = self.observations.lock().unwrap();
        observations
            .iter()
            .rev()
            .take(limit)
            .rev()
            .cloned()
            .collect()
    }
}

impl Store for MemoryStore {
    fn add_observation(&self, observation: Observation) {
        let mut observations = self.observations.lock().unwrap();
        observations.push(observation);
        let overflow = observations.len().saturating_sub(MAX_OBSERVATIONS);
        if overflow > 0 {
            observations.drain(..overflow);
        }
    }

    fn observations(&self) -> Vec<Observation> {
        self.observations.lock().unwrap().clone()
    }

    fn observation_count(&self) -> usize {
        self.observations.lock().unwrap().len()
    }

    fn invalid_frames(&self) -> usize {
        *self.invalid_frames.lock().unwrap()
    }

    fn add_invalid_frame(&self) {
        *self.invalid_frames.lock().unwrap() += 1;
    }
}

const MAX_OBSERVATIONS: usize = 10_000;
const MAX_EXPORT_OBSERVATIONS: usize = 10_000;

pub fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

pub fn export_observations_jsonl<W: std::io::Write>(
    mut writer: W,
    observations: &[Observation],
) -> std::io::Result<()> {
    let limited: &[Observation] = if observations.len() > MAX_EXPORT_OBSERVATIONS {
        &observations[observations.len() - MAX_EXPORT_OBSERVATIONS..]
    } else {
        observations
    };
    for observation in limited {
        serde_json::to_writer(&mut writer, observation)?;
        writer.write_all(b"\n")?;
    }
    writer.flush()
}
