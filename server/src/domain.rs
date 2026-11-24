use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub struct AppServices {
    #[allow(dead_code)]
    store: std::sync::Arc<dyn crate::Store>,
    inner: Mutex<DomainState>,
    next_id: AtomicU64,
}

#[derive(Default)]
struct DomainState {
    accounts: HashMap<u64, Account>,
    usernames: HashMap<String, u64>,
    tokens: HashMap<String, u64>,
    rooms: HashMap<u64, Room>,
    battles: HashMap<u64, Battle>,
    shop_items: HashMap<&'static str, ShopItem>,
    orders: Vec<Order>,
}

#[derive(Debug, Clone)]
struct Account {
    id: u64,
    username: String,
    password: String,
    balance: i64,
    inventory: HashMap<String, u32>,
}

#[derive(Debug, Clone)]
struct Room {
    id: u64,
    owner_id: u64,
    mode: String,
    state: &'static str,
    members: HashMap<u64, bool>,
}

#[derive(Debug, Clone)]
struct Battle {
    id: u64,
    room_id: u64,
    state: &'static str,
    participants: Vec<u64>,
    frames: Vec<BattleFrame>,
    result: Option<String>,
    score: i64,
}

#[derive(Debug, Clone, Serialize)]
struct BattleFrame {
    frame_no: u64,
    payload: String,
}

#[derive(Debug, Clone)]
struct ShopItem {
    id: &'static str,
    name: &'static str,
    price: i64,
}

#[derive(Debug, Clone, Serialize)]
struct Order {
    id: u64,
    account_id: u64,
    item_id: String,
    quantity: u32,
    total: i64,
    status: &'static str,
}

#[derive(Debug)]
pub enum DomainError {
    Unauthorized,
    Conflict(String),
    NotFound(String),
    InvalidRequest(String),
}

#[derive(Debug, Deserialize)]
pub struct AccountRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct JoinRequest {
    #[serde(rename = "roomId")]
    pub room_id: u64,
}

#[derive(Debug, Deserialize)]
pub struct ReadyRequest {
    #[serde(rename = "roomId")]
    pub room_id: u64,
    pub ready: bool,
}

#[derive(Debug, Deserialize)]
pub struct BattleRequest {
    #[serde(rename = "battleId")]
    pub battle_id: u64,
}

#[derive(Debug, Deserialize)]
pub struct FrameRequest {
    #[serde(rename = "battleId")]
    pub battle_id: u64,
    #[serde(rename = "frameNo")]
    pub frame_no: u64,
    pub payload: String,
}

#[derive(Debug, Deserialize)]
pub struct SettleRequest {
    #[serde(rename = "battleId")]
    pub battle_id: u64,
    pub result: String,
    pub score: i64,
}

#[derive(Debug, Deserialize)]
pub struct PurchaseRequest {
    #[serde(rename = "itemId")]
    pub item_id: String,
    pub quantity: u32,
}

impl AppServices {
    pub fn new(store: std::sync::Arc<dyn crate::Store>) -> Self {
        let mut shop_items = HashMap::new();
        for item in [
            ShopItem {
                id: "hero",
                name: "Hero",
                price: 300,
            },
            ShopItem {
                id: "skin",
                name: "Skin",
                price: 800,
            },
            ShopItem {
                id: "chest",
                name: "Chest",
                price: 100,
            },
        ] {
            shop_items.insert(item.id, item);
        }
        Self {
            store,
            inner: Mutex::new(DomainState {
                shop_items,
                ..DomainState::default()
            }),
            next_id: AtomicU64::new(1),
        }
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    pub fn register(&self, request: AccountRequest) -> Result<serde_json::Value, DomainError> {
        if request.username.trim().is_empty() || request.password.len() < 4 {
            return Err(DomainError::InvalidRequest(
                "invalid username or password".into(),
            ));
        }
        let mut state = self.inner.lock().unwrap();
        if state.usernames.contains_key(&request.username) {
            return Err(DomainError::Conflict("username already exists".into()));
        }
        let id = self.next_id();
        state.usernames.insert(request.username.clone(), id);
        state.accounts.insert(
            id,
            Account {
                id,
                username: request.username,
                password: request.password,
                balance: 1000,
                inventory: HashMap::new(),
            },
        );
        let account = state.accounts.get(&id).unwrap();
        Ok(json!({ "id": id, "username": account.username, "balance": account.balance }))
    }

    pub fn login(&self, request: AccountRequest) -> Result<serde_json::Value, DomainError> {
        let mut state = self.inner.lock().unwrap();
        let id = *state
            .usernames
            .get(&request.username)
            .ok_or_else(|| DomainError::Unauthorized)?;
        let account = state
            .accounts
            .get(&id)
            .ok_or_else(|| DomainError::Unauthorized)?;
        if account.password != request.password {
            return Err(DomainError::Unauthorized);
        }
        let token = format!("wzry-{id}-{}", self.next_id());
        state.tokens.insert(token.clone(), id);
        Ok(json!({ "token": token, "accountId": id }))
    }

    fn account_id(&self, state: &DomainState, token: &str) -> Result<u64, DomainError> {
        state
            .tokens
            .get(token)
            .copied()
            .ok_or(DomainError::Unauthorized)
    }

    pub fn profile(&self, token: Option<&str>) -> Result<serde_json::Value, DomainError> {
        let state = self.inner.lock().unwrap();
        let id = Self::account_id(&self, &state, token.ok_or(DomainError::Unauthorized)?)?;
        let account = state.accounts.get(&id).unwrap();
        Ok(json!({
            "id": account.id,
            "username": account.username,
            "balance": account.balance,
            "inventory": account.inventory,
        }))
    }

    pub fn create_room(
        &self,
        token: Option<&str>,
        mode: String,
    ) -> Result<serde_json::Value, DomainError> {
        let mut state = self.inner.lock().unwrap();
        let owner_id = Self::account_id(&self, &state, token.ok_or(DomainError::Unauthorized)?)?;
        let id = self.next_id();
        let mut members = HashMap::new();
        members.insert(owner_id, false);
        state.rooms.insert(
            id,
            Room {
                id,
                owner_id,
                mode,
                state: "lobby",
                members,
            },
        );
        Ok(
            json!({ "id": id, "ownerId": owner_id, "mode": state.rooms[&id].mode, "state": "lobby" }),
        )
    }

    pub fn join_room(
        &self,
        token: Option<&str>,
        request: JoinRequest,
    ) -> Result<serde_json::Value, DomainError> {
        let mut state = self.inner.lock().unwrap();
        let account_id = Self::account_id(&self, &state, token.ok_or(DomainError::Unauthorized)?)?;
        let room = state
            .rooms
            .get_mut(&request.room_id)
            .ok_or_else(|| DomainError::NotFound("room not found".into()))?;
        if room.state != "lobby" {
            return Err(DomainError::Conflict("room is not in lobby".into()));
        }
        if room.members.contains_key(&account_id) {
            return Err(DomainError::Conflict("already joined".into()));
        }
        room.members.insert(account_id, false);
        Ok(json!({ "roomId": room.id, "accountId": account_id }))
    }

    pub fn ready_room(
        &self,
        token: Option<&str>,
        request: ReadyRequest,
    ) -> Result<serde_json::Value, DomainError> {
        let mut state = self.inner.lock().unwrap();
        let account_id = Self::account_id(&self, &state, token.ok_or(DomainError::Unauthorized)?)?;
        let room = state
            .rooms
            .get_mut(&request.room_id)
            .ok_or_else(|| DomainError::NotFound("room not found".into()))?;
        *room
            .members
            .get_mut(&account_id)
            .ok_or_else(|| DomainError::Conflict("not a room member".into()))? = request.ready;
        Ok(json!({ "roomId": room.id, "ready": request.ready }))
    }

    pub fn start_battle(
        &self,
        token: Option<&str>,
        room_id: u64,
    ) -> Result<serde_json::Value, DomainError> {
        let mut state = self.inner.lock().unwrap();
        let owner_id = Self::account_id(&self, &state, token.ok_or(DomainError::Unauthorized)?)?;
        let room = state
            .rooms
            .get_mut(&room_id)
            .ok_or_else(|| DomainError::NotFound("room not found".into()))?;
        if room.owner_id != owner_id {
            return Err(DomainError::Conflict("only owner can start".into()));
        }
        if room.members.len() < 2 || room.members.values().any(|ready| !ready) {
            return Err(DomainError::Conflict("members are not ready".into()));
        }
        room.state = "running";
        let battle_id = self.next_id();
        let battle = Battle {
            id: battle_id,
            room_id,
            state: "running",
            participants: room.members.keys().copied().collect(),
            frames: Vec::new(),
            result: None,
            score: 0,
        };
        let response = json!({ "id": battle.id, "roomId": battle.room_id, "state": battle.state, "participants": battle.participants });
        state.battles.insert(battle_id, battle);
        Ok(response)
    }

    pub fn add_frame(
        &self,
        token: Option<&str>,
        request: FrameRequest,
    ) -> Result<serde_json::Value, DomainError> {
        let mut state = self.inner.lock().unwrap();
        let account_id = Self::account_id(&self, &state, token.ok_or(DomainError::Unauthorized)?)?;
        let battle = state
            .battles
            .get_mut(&request.battle_id)
            .ok_or_else(|| DomainError::NotFound("battle not found".into()))?;
        if !battle.participants.contains(&account_id) || battle.state != "running" {
            return Err(DomainError::Conflict(
                "battle is not active for account".into(),
            ));
        }
        battle.frames.push(BattleFrame {
            frame_no: request.frame_no,
            payload: request.payload,
        });
        Ok(json!({ "battleId": battle.id, "frameNo": request.frame_no }))
    }

    pub fn settle_battle(
        &self,
        token: Option<&str>,
        request: SettleRequest,
    ) -> Result<serde_json::Value, DomainError> {
        let mut state = self.inner.lock().unwrap();
        let account_id = Self::account_id(&self, &state, token.ok_or(DomainError::Unauthorized)?)?;
        let battle = state
            .battles
            .get_mut(&request.battle_id)
            .ok_or_else(|| DomainError::NotFound("battle not found".into()))?;
        if !battle.participants.contains(&account_id) || battle.state != "running" {
            return Err(DomainError::Conflict(
                "battle is not active for account".into(),
            ));
        }
        battle.state = "settled";
        battle.result = Some(request.result);
        battle.score = request.score;
        let room_id = battle.room_id;
        let response = json!({ "id": battle.id, "state": battle.state, "result": battle.result, "score": battle.score });
        let _ = battle;
        if let Some(room) = state.rooms.get_mut(&room_id) {
            room.state = "settled";
        }
        Ok(response)
    }

    pub fn get_battle(
        &self,
        token: Option<&str>,
        request: BattleRequest,
    ) -> Result<serde_json::Value, DomainError> {
        let state = self.inner.lock().unwrap();
        let account_id = Self::account_id(&self, &state, token.ok_or(DomainError::Unauthorized)?)?;
        let battle = state
            .battles
            .get(&request.battle_id)
            .ok_or_else(|| DomainError::NotFound("battle not found".into()))?;
        if !battle.participants.contains(&account_id) {
            return Err(DomainError::Conflict("not a participant".into()));
        }
        Ok(
            json!({ "id": battle.id, "state": battle.state, "result": battle.result, "score": battle.score, "frames": battle.frames }),
        )
    }

    pub fn shop_items(&self) -> serde_json::Value {
        let state = self.inner.lock().unwrap();
        let items = state
            .shop_items
            .values()
            .map(|item| json!({"id": item.id, "name": item.name, "price": item.price }))
            .collect::<Vec<_>>();
        json!({ "items": items })
    }

    pub fn shop_profile(&self, token: Option<&str>) -> Result<serde_json::Value, DomainError> {
        self.profile(token)
    }

    pub fn purchase(
        &self,
        token: Option<&str>,
        request: PurchaseRequest,
    ) -> Result<serde_json::Value, DomainError> {
        if request.quantity == 0 {
            return Err(DomainError::InvalidRequest(
                "quantity must be positive".into(),
            ));
        }
        let mut state = self.inner.lock().unwrap();
        let account_id = Self::account_id(&self, &state, token.ok_or(DomainError::Unauthorized)?)?;
        let item = state
            .shop_items
            .get(request.item_id.as_str())
            .ok_or_else(|| DomainError::NotFound("shop item not found".into()))?
            .clone();
        let total = item
            .price
            .checked_mul(request.quantity as i64)
            .ok_or_else(|| DomainError::InvalidRequest("quantity overflow".into()))?;
        let account = state
            .accounts
            .get_mut(&account_id)
            .ok_or_else(|| DomainError::NotFound("account not found".into()))?;
        if account.balance < total {
            return Err(DomainError::Conflict("insufficient balance".into()));
        }
        account.balance -= total;
        *account
            .inventory
            .entry(request.item_id.clone())
            .or_insert(0) += request.quantity;
        let order_id = self.next_id();
        let order = Order {
            id: order_id,
            account_id,
            item_id: request.item_id,
            quantity: request.quantity,
            total,
            status: "completed",
        };
        let response = json!({ "id": order.id, "itemId": order.item_id, "quantity": order.quantity, "total": order.total, "status": order.status });
        state.orders.push(order);
        Ok(response)
    }
}
