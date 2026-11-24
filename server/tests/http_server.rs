use std::sync::Arc;
use wzry_local_server::http::response_for;
use wzry_local_server::{AppState, MemoryStore, Store};

#[test]
fn health_reports_status() {
    let response = wzry_local_server::route(
        b"GET /health HTTP/1.1\r\n\r\n",
        AppState::default(),
        &(Arc::new(MemoryStore::new()) as Arc<dyn Store>),
    )
    .unwrap();
    assert_eq!(response["status"], "ok");
    assert_eq!(response["http"], "ok");
    assert_eq!(response["frame"], "ok");
    assert_eq!(response["database"], "ok");
    assert_eq!(response["protocol"], "observing");
    assert_eq!(response["epoch"], 1);
}

#[test]
fn unknown_route_returns_json_404() {
    let _response = wzry_local_server::route(
        b"GET /missing HTTP/1.1\r\n\r\n",
        AppState::default(),
        &(Arc::new(MemoryStore::new()) as Arc<dyn Store>),
    )
    .unwrap_err();
    let bytes = response_for(Err(wzry_local_server::route(
        b"GET /missing HTTP/1.1\r\n\r\n",
        AppState::default(),
        &(Arc::new(MemoryStore::new()) as Arc<dyn Store>),
    )
    .unwrap_err()));
    assert!(bytes.starts_with(b"HTTP/1.1 404"));
    assert!(String::from_utf8_lossy(&bytes).contains("\"code\":\"NOT_FOUND\""));
}

#[test]
fn debug_observations_are_read_only() {
    let store: Arc<dyn Store> = Arc::new(MemoryStore::new());
    store.add_observation(wzry_local_server::Observation {
        channel: "http",
        method_id: Some(123),
        command: None,
        sequence: None,
        bytes: 2,
        status: 501,
    });
    let response = wzry_local_server::route(
        b"GET /debug/observations HTTP/1.1\r\n\r\n",
        AppState::default(),
        &store,
    )
    .unwrap();
    assert_eq!(response["observations"][0]["methodId"], 123);
    assert_eq!(store.observation_count(), 1);
}

#[test]
fn unknown_protocol_returns_501_and_observes() {
    let store: Arc<dyn Store> = Arc::new(MemoryStore::new());
    let request =
        b"POST /game HTTP/1.1\r\nContent-Length: 30\r\n\r\n{\"methodId\":12345,\"body\":{\"x\":1}}";
    let error = wzry_local_server::route(request, AppState::default(), &store).unwrap_err();
    let bytes = response_for(Err(error));
    assert!(bytes.starts_with(b"HTTP/1.1 501"));
    assert_eq!(store.observation_count(), 1);
    assert_eq!(store.observations()[0].method_id, Some(12345));
}

#[test]
fn oversized_body_returns_413() {
    let state = AppState {
        http_body_bytes: 8,
        epoch: 1,
    };
    let error = wzry_local_server::route(
        b"POST /game HTTP/1.1\r\n\r\n123456789",
        state,
        &(Arc::new(MemoryStore::new()) as Arc<dyn Store>),
    )
    .unwrap_err();
    assert!(response_for(Err(error)).starts_with(b"HTTP/1.1 413"));
}
