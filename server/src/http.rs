use crate::store::{Observation, Store};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Copy)]
pub struct AppState {
    pub http_body_bytes: usize,
    pub epoch: u64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            http_body_bytes: 65536,
            epoch: 1,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Health {
    pub status: &'static str,
    pub http: &'static str,
    pub frame: &'static str,
    pub database: &'static str,
    pub protocol: &'static str,
    pub epoch: u64,
}

#[derive(Debug, Deserialize)]
pub struct GameRequest {
    #[serde(rename = "methodId")]
    pub method_id: u64,
    #[serde(default)]
    pub body: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Serialize)]
pub struct ErrorDetail {
    pub code: &'static str,
    pub message: &'static str,
}

#[derive(Debug)]
pub enum RouteError {
    NotFound,
    MethodNotAllowed,
    BodyTooLarge,
    InvalidJson,
    ProtocolNotImplemented,
}

pub fn response_status(result: &Result<serde_json::Value, RouteError>) -> u16 {
    match result {
        Ok(_) => 200,
        Err(RouteError::NotFound) => 404,
        Err(RouteError::MethodNotAllowed) => 405,
        Err(RouteError::BodyTooLarge) => 413,
        Err(RouteError::InvalidJson) => 400,
        Err(RouteError::ProtocolNotImplemented) => 501,
    }
}

pub fn response_for(result: Result<serde_json::Value, RouteError>) -> Vec<u8> {
    let (status, payload): (u16, serde_json::Value) = match result {
        Ok(value) => (200, value),
        Err(RouteError::NotFound) => error_response(404, "NOT_FOUND", "route not found"),
        Err(RouteError::MethodNotAllowed) => {
            error_response(405, "METHOD_NOT_ALLOWED", "method not allowed")
        }
        Err(RouteError::BodyTooLarge) => {
            error_response(413, "BODY_TOO_LARGE", "request body is too large")
        }
        Err(RouteError::InvalidJson) => {
            error_response(400, "INVALID_JSON", "request body is not valid JSON")
        }
        Err(RouteError::ProtocolNotImplemented) => {
            error_response(501, "PROTOCOL_NOT_IMPLEMENTED", "method is not implemented")
        }
    };
    let body = serde_json::to_vec(&payload).unwrap();
    format!(
        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        status,
        body.len()
    )
    .into_bytes()
    .into_iter()
    .chain(body)
    .collect()
}

fn error_response(
    status: u16,
    code: &'static str,
    message: &'static str,
) -> (u16, serde_json::Value) {
    (
        status,
        serde_json::to_value(ErrorBody {
            error: ErrorDetail { code, message },
        })
        .unwrap(),
    )
}

pub fn health(state: AppState) -> Health {
    Health {
        status: "ok",
        http: "ok",
        frame: "ok",
        database: "ok",
        protocol: "observing",
        epoch: state.epoch,
    }
}

pub fn route(
    request: &[u8],
    state: AppState,
    store: &Arc<dyn Store>,
) -> Result<serde_json::Value, RouteError> {
    let parts: Vec<_> = split_path(request);
    match parts.as_slice() {
        [method, path] if method == "GET" && path == "/health" => {
            Ok(serde_json::to_value(health(state)).unwrap())
        }
        [method, path] if method == "GET" && path == "/debug/observations" => {
            let observations = store
                .observations()
                .into_iter()
                .map(|observation| {
                    serde_json::json!({
                        "channel": observation.channel,
                        "methodId": observation.method_id,
                        "command": observation.command,
                        "sequence": observation.sequence,
                        "bytes": observation.bytes,
                        "status": observation.status,
                    })
                })
                .collect::<Vec<_>>();
            Ok(serde_json::json!({ "observations": observations }))
        }
        [method, path] if method == "POST" && path == "/game" => {
            let body = request_body(request).ok_or(RouteError::BodyTooLarge)?;
            if body.len() > state.http_body_bytes {
                return Err(RouteError::BodyTooLarge);
            }
            let payload: GameRequest =
                serde_json::from_slice(body).map_err(|_| RouteError::InvalidJson)?;
            store.add_observation(Observation {
                channel: "http",
                method_id: Some(payload.method_id),
                command: None,
                sequence: None,
                bytes: body.len(),
                status: 501,
            });
            Err(RouteError::ProtocolNotImplemented)
        }
        _ => Err(RouteError::NotFound),
    }
}

fn split_path(request: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(request);
    text.split_whitespace()
        .take(2)
        .map(str::to_string)
        .collect()
}

fn request_body(request: &[u8]) -> Option<&[u8]> {
    let split = request
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?;
    Some(&request[split + 4..])
}
