use wzry_local_server::{export_observations_jsonl, MemoryStore, Observation, Store};

#[test]
fn exports_bounded_jsonl_observations() {
    let store = MemoryStore::new();
    for index in 0..3 {
        let mut observation = Observation::now("http");
        observation.source = Some(format!("peer:{index}"));
        observation.method_id = Some(index as u64);
        observation.bytes = index;
        observation.status = 501;
        store.add_observation(observation);
    }

    let mut output = Vec::new();
    export_observations_jsonl(&mut output, &store.observations()).unwrap();
    let lines = String::from_utf8(output).unwrap();
    let records: Vec<_> = lines.lines().collect();
    assert_eq!(records.len(), 3);
    assert!(records[0].contains("\"peer:0\""));
    assert!(records[0].contains("\"methodId\":0"));
    assert!(records[0].contains("\"recordedAtUnixMs\":"));
    assert!(records[2].contains("\"peer:2\""));
}

#[test]
fn observation_export_keeps_only_the_latest_10k_records() {
    let observations: Vec<_> = (0..10_002)
        .map(|index| {
            let mut observation = Observation::now("tcp");
            observation.source = Some(format!("peer:{index}"));
            observation.bytes = index;
            observation
        })
        .collect();

    let mut output = Vec::new();
    export_observations_jsonl(&mut output, &observations).unwrap();
    let lines = String::from_utf8(output).unwrap();
    let records: Vec<_> = lines.lines().collect();
    assert_eq!(records.len(), 10_000);
    assert!(records[0].contains("\"peer:2\""));
    assert!(records.last().unwrap().contains("\"peer:10001\""));
}
