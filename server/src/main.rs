use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use wzry_local_server::{AppState, FrameConfig, FrameParser, MemoryStore, Store};

fn main() {
    let store = Arc::new(MemoryStore::new());
    let listener = TcpListener::bind("127.0.0.1:19620").expect("bind HTTP server");
    let frame_listener = TcpListener::bind("127.0.0.1:19621").expect("bind frame server");
    println!("HTTP listening on {}", listener.local_addr().unwrap());
    println!(
        "Frame listening on {}",
        frame_listener.local_addr().unwrap()
    );

    let frame_store = Arc::clone(&store);
    std::thread::spawn(move || {
        for connection in frame_listener.incoming() {
            if let Ok(mut stream) = connection {
                let store = Arc::clone(&frame_store);
                std::thread::spawn(move || handle_frame_connection(&mut stream, store));
            }
        }
    });

    for connection in listener.incoming() {
        if let Ok(mut stream) = connection {
            let store = Arc::clone(&store);
            std::thread::spawn(move || handle_http_connection(&mut stream, store));
        }
    }
}

fn handle_http_connection(stream: &mut TcpStream, store: Arc<dyn Store>) {
    let mut request = [0u8; 65536];
    let read = stream.read(&mut request).unwrap_or(0);
    let state = AppState::default();
    let result = wzry_local_server::route(&request[..read], state, &store);
    let response = wzry_local_server::http::response_for(result);
    let _ = stream.write_all(&response);
}

fn handle_frame_connection(stream: &mut TcpStream, store: Arc<dyn Store>) {
    let mut parser = FrameParser::new(FrameConfig {
        max_packet_bytes: 1048576,
    });
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(read) => match parser.feed(&buffer[..read]) {
                Ok(frames) => {
                    for frame in frames {
                        store.add_observation(wzry_local_server::store::Observation {
                            channel: "tcp",
                            method_id: None,
                            command: Some(frame.command),
                            sequence: Some(frame.sequence),
                            bytes: frame.body.len(),
                            status: 200,
                        });
                    }
                }
                Err(_) => {
                    store.add_invalid_frame();
                    return;
                }
            },
        }
    }
}
