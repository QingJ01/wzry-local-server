use std::sync::Arc;
use wzry_local_server::http::response_for;
use wzry_local_server::http::RequestHandler;
use wzry_local_server::{AppServices, AppState, MemoryStore};

fn services() -> AppServices {
    AppServices::new(Arc::new(MemoryStore::new()))
}

fn request(method: &str, path: &str, token: Option<&str>, body: Option<&str>) -> Vec<u8> {
    let authorization = token
        .map(|value| format!("Authorization: Bearer {value}\r\n"))
        .unwrap_or_default();
    let body = body.unwrap_or("");
    format!(
        "{method} {path} HTTP/1.1\r\n{authorization}Content-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn json_body(value: serde_json::Value) -> String {
    serde_json::to_string(&value).unwrap()
}

#[test]
fn account_register_login_and_profile_flow() {
    let app = services();
    let register = wzry_local_server::http::route_with_handler(
        &request(
            "POST",
            "/accounts/register",
            None,
            Some(r#"{"username":"qingj","password":"secret"}"#),
        ),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap();
    assert_eq!(register["username"], "qingj");
    assert_eq!(register["balance"], 1000);

    let login = wzry_local_server::http::route_with_handler(
        &request(
            "POST",
            "/accounts/login",
            None,
            Some(r#"{"username":"qingj","password":"secret"}"#),
        ),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap();
    let token = login["token"].as_str().unwrap();
    assert!(!token.is_empty());

    let profile = wzry_local_server::http::route_with_handler(
        &request("GET", "/accounts/me", Some(token), None),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap();
    assert_eq!(profile["username"], "qingj");
    assert_eq!(profile["balance"], 1000);
}

#[test]
fn duplicate_account_is_rejected() {
    let app = services();
    let body = r#"{"username":"same","password":"secret"}"#;
    wzry_local_server::http::route_with_handler(
        &request("POST", "/accounts/register", None, Some(body)),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap();
    let error = wzry_local_server::http::route_with_handler(
        &request("POST", "/accounts/register", None, Some(body)),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap_err();
    let response = response_for(Err(error));
    assert!(response.starts_with(b"HTTP/1.1 409"));
}

#[test]
fn battle_room_ready_start_frame_and_settle_flow() {
    let app = services();
    let owner_token = login(&app, "owner");
    let guest_token = login(&app, "guest");

    let room = wzry_local_server::http::route_with_handler(
        &request(
            "POST",
            "/rooms",
            Some(&owner_token),
            Some(r#"{"mode":"ranked"}"#),
        ),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap();
    let room_id = room["id"].as_u64().unwrap();
    assert_eq!(room["state"], "lobby");

    wzry_local_server::http::route_with_handler(
        &request(
            "POST",
            "/rooms/join",
            Some(&guest_token),
            Some(&json_body(serde_json::json!({ "roomId": room_id }))),
        ),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap();

    for token in [&owner_token, &guest_token] {
        wzry_local_server::http::route_with_handler(
            &request(
                "POST",
                "/rooms/ready",
                Some(token),
                Some(&json_body(
                    serde_json::json!({ "roomId": room_id, "ready": true }),
                )),
            ),
            AppState::default(),
            &RequestHandler::Services(&app),
        )
        .unwrap();
    }

    let battle = wzry_local_server::http::route_with_handler(
        &request(
            "POST",
            "/battles/start",
            Some(&owner_token),
            Some(&json_body(serde_json::json!({ "roomId": room_id }))),
        ),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap();
    let battle_id = battle["id"].as_u64().unwrap();
    assert_eq!(battle["state"], "running");
    assert_eq!(battle["participants"].as_array().unwrap().len(), 2);

    wzry_local_server::http::route_with_handler(
        &request(
            "POST",
            "/battles/frame",
            Some(&owner_token),
            Some(&json_body(serde_json::json!({
                "battleId": battle_id,
                "frameNo": 1,
                "payload": "aGk="
            }))),
        ),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap();

    let settled = wzry_local_server::http::route_with_handler(
        &request(
            "POST",
            "/battles/settle",
            Some(&owner_token),
            Some(&json_body(serde_json::json!({
                "battleId": battle_id,
                "result": "win",
                "score": 100
            }))),
        ),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap();
    assert_eq!(settled["state"], "settled");
    assert_eq!(settled["result"], "win");

    let battle_view = wzry_local_server::http::route_with_handler(
        &request(
            "POST",
            "/battles/get",
            Some(&guest_token),
            Some(&json_body(serde_json::json!({ "battleId": battle_id }))),
        ),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap();
    assert_eq!(battle_view["frames"].as_array().unwrap().len(), 1);
}

#[test]
fn shop_purchase_updates_balance_inventory_and_orders() {
    let app = services();
    let token = login(&app, "shopper");

    let items = wzry_local_server::http::route_with_handler(
        &request("GET", "/shop/items", None, None),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap();
    assert_eq!(items["items"].as_array().unwrap().len(), 3);

    let order = wzry_local_server::http::route_with_handler(
        &request(
            "POST",
            "/shop/purchase",
            Some(&token),
            Some(r#"{"itemId":"hero","quantity":2}"#),
        ),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap();
    assert_eq!(order["status"], "completed");
    assert_eq!(order["total"], 600);

    let profile = wzry_local_server::http::route_with_handler(
        &request("GET", "/shop/profile", Some(&token), None),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap();
    assert_eq!(profile["balance"], 400);
    assert_eq!(profile["inventory"]["hero"], 2);

    let error = wzry_local_server::http::route_with_handler(
        &request(
            "POST",
            "/shop/purchase",
            Some(&token),
            Some(r#"{"itemId":"hero","quantity":100}"#),
        ),
        AppState::default(),
        &RequestHandler::Services(&app),
    )
    .unwrap_err();
    let response = response_for(Err(error));
    assert!(response.starts_with(b"HTTP/1.1 409"));
}

#[test]
fn account_battle_and_shop_requests_require_valid_token() {
    let app = services();
    for (method, path, body) in [
        ("GET", "/accounts/me", None),
        ("POST", "/rooms", Some(r#"{"mode":"ranked"}"#)),
        ("GET", "/shop/profile", None),
    ] {
        let error = wzry_local_server::http::route_with_handler(
            &request(method, path, None, body),
            AppState::default(),
            &RequestHandler::Services(&app),
        )
        .unwrap_err();
        let response = response_for(Err(error));
        assert!(response.starts_with(b"HTTP/1.1 401"), "path={path}");
    }
}

fn login(app: &AppServices, username: &str) -> String {
    let register = wzry_local_server::http::route_with_handler(
        &request(
            "POST",
            "/accounts/register",
            None,
            Some(&json_body(serde_json::json!({
                "username": username,
                "password": "secret"
            }))),
        ),
        AppState::default(),
        &RequestHandler::Services(app),
    );
    let _ = register;
    let response = wzry_local_server::http::route_with_handler(
        &request(
            "POST",
            "/accounts/login",
            None,
            Some(&json_body(serde_json::json!({
                "username": username,
                "password": "secret"
            }))),
        ),
        AppState::default(),
        &RequestHandler::Services(app),
    )
    .unwrap();
    response["token"].as_str().unwrap().to_string()
}
