use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    pub channel: &'static str,
    pub method_id: Option<u64>,
    pub command: Option<u16>,
    pub sequence: Option<u16>,
    pub bytes: usize,
    pub status: u16,
}

pub trait Store: Send {
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
}

impl Store for MemoryStore {
    fn add_observation(&self, observation: Observation) {
        self.observations.lock().unwrap().push(observation);
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
