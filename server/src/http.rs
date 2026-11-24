use crate::store::{Observation, Store};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::Arc;

pub type RouteResult = Result<serde_json::Value, RouteError>;

#[derive(Clone)]
pub enum RequestHandler<'a> {
    Store(&'a Arc<dyn Store>),
    Services {
        services: &'a crate::domain::AppServices,
        store: Option<&'a Arc<dyn Store>>,
    },
}

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

fn store<'a>(handler: &'a RequestHandler<'_>) -> Option<&'a Arc<dyn Store>> {
    match handler {
        RequestHandler::Store(store) => Some(store),
        RequestHandler::Services { store, .. } => *store,
    }
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
    pub message: String,
}

#[derive(Debug)]
pub enum RouteError {
    NotFound,
    MethodNotAllowed,
    BodyTooLarge,
    InvalidJson,
    ProtocolNotImplemented,
    Unauthorized,
    Conflict(String),
    InvalidDomainRequest(String),
}

pub fn response_status(result: &Result<serde_json::Value, RouteError>) -> u16 {
    match result {
        Ok(_) => 200,
        Err(RouteError::NotFound) => 404,
        Err(RouteError::MethodNotAllowed) => 405,
        Err(RouteError::BodyTooLarge) => 413,
        Err(RouteError::InvalidJson) => 400,
        Err(RouteError::ProtocolNotImplemented) => 501,
        Err(RouteError::Unauthorized) => 401,
        Err(RouteError::Conflict(_)) => 409,
        Err(RouteError::InvalidDomainRequest(_)) => 400,
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
        Err(RouteError::Unauthorized) => {
            error_response(401, "UNAUTHORIZED", "authentication required")
        }
        Err(RouteError::Conflict(message)) => error_response(409, "CONFLICT", &message),
        Err(RouteError::InvalidDomainRequest(message)) => {
            error_response(400, "INVALID_REQUEST", &message)
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

fn error_response(status: u16, code: &'static str, message: &str) -> (u16, serde_json::Value) {
    (
        status,
        serde_json::to_value(ErrorBody {
            error: ErrorDetail {
                code,
                message: message.to_string(),
            },
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
    let handler = RequestHandler::Store(store);
    route_with_handler(request, state, &handler)
}

pub fn route_with_handler(
    request: &[u8],
    state: AppState,
    handler: &RequestHandler<'_>,
) -> Result<serde_json::Value, RouteError> {
    let parts: Vec<_> = split_path(request);
    match parts.as_slice() {
        [method, path] if method == "GET" && path == "/health" => {
            Ok(serde_json::to_value(health(state)).unwrap())
        }
        [method, path] if method == "GET" && path == "/debug/observations" => {
            let store = match handler {
                RequestHandler::Store(store) => store,
                RequestHandler::Services { store: None, .. } => {
                    return Err(RouteError::NotFound);
                }
                RequestHandler::Services {
                    store: Some(store), ..
                } => store,
            };
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
            let store = store(handler).expect("store handler");
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
        _ => route_domain(request, state, handler),
    }
}

fn route_domain(
    request: &[u8],
    _state: AppState,
    handler: &RequestHandler<'_>,
) -> Result<serde_json::Value, RouteError> {
    let services = match handler {
        RequestHandler::Services { services, .. } => services,
        RequestHandler::Store(_) => return Err(RouteError::NotFound),
    };
    let parts: Vec<_> = split_path(request);
    let method = parts.first().map(String::as_str).unwrap_or_default();
    let path = parts.get(1).map(String::as_str).unwrap_or_default();
    let body = request_body(request).unwrap_or_default();
    let token = bearer_token(request);
    let result = match (method, path) {
        ("POST", "/accounts/register") => {
            services.register(parse_body(body)?).map_err(domain_error)
        }
        ("POST", "/accounts/login") => services.login(parse_body(body)?).map_err(domain_error),
        ("GET", "/accounts/me") => services.profile(token.as_deref()).map_err(domain_error),
        ("POST", "/rooms") => services
            .create_room(token.as_deref(), json_field(body, "mode")?)
            .map_err(domain_error),
        ("POST", "/rooms/join") => services
            .join_room(token.as_deref(), parse_body(body)?)
            .map_err(domain_error),
        ("POST", "/rooms/ready") => services
            .ready_room(token.as_deref(), parse_body(body)?)
            .map_err(domain_error),
        ("POST", "/battles/start") => services
            .start_battle(token.as_deref(), json_field(body, "roomId")?)
            .map_err(domain_error),
        ("POST", "/battles/frame") => services
            .add_frame(token.as_deref(), parse_body(body)?)
            .map_err(domain_error),
        ("POST", "/battles/settle") => services
            .settle_battle(token.as_deref(), parse_body(body)?)
            .map_err(domain_error),
        ("POST", "/battles/get") => services
            .get_battle(token.as_deref(), parse_body(body)?)
            .map_err(domain_error),
        ("GET", "/shop/items") => Ok(services.shop_items()),
        ("GET", "/shop/profile") => services
            .shop_profile(token.as_deref())
            .map_err(domain_error),
        ("POST", "/shop/purchase") => services
            .purchase(token.as_deref(), parse_body(body)?)
            .map_err(domain_error),
        _ => Err(RouteError::NotFound),
    };
    result
}

fn parse_body<T: DeserializeOwned>(body: &[u8]) -> Result<T, RouteError> {
    serde_json::from_slice(body).map_err(|_| RouteError::InvalidJson)
}

fn json_field<T: DeserializeOwned>(body: &[u8], field: &'static str) -> Result<T, RouteError> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| RouteError::InvalidJson)?;
    serde_json::from_value(value[field].clone()).map_err(|_| RouteError::InvalidJson)
}

fn bearer_token(request: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(request);
    text.lines()
        .find_map(|line| line.strip_prefix("Authorization: Bearer "))
        .map(str::to_string)
}

fn domain_error(error: crate::domain::DomainError) -> RouteError {
    match error {
        crate::domain::DomainError::Unauthorized => RouteError::Unauthorized,
        crate::domain::DomainError::Conflict(message) => RouteError::Conflict(message),
        crate::domain::DomainError::NotFound(message) => RouteError::Conflict(message),
        crate::domain::DomainError::InvalidRequest(message) => {
            RouteError::InvalidDomainRequest(message)
        }
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
