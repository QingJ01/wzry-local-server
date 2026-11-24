use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use wzry_local_server::http::response_status;
use wzry_local_server::read_request::RequestReader;
use wzry_local_server::{
    http, AppServices, AppState, FrameConfig, FrameParser, MemoryStore, Store,
};

fn main() {
    let store = Arc::new(MemoryStore::new());
    let services = Arc::new(AppServices::new(Arc::clone(&store) as Arc<dyn Store>));
    let http_address = std::env::var("WZRY_HTTP_ADDR").unwrap_or_else(|_| "127.0.0.1:19620".into());
    let frame_address =
        std::env::var("WZRY_FRAME_ADDR").unwrap_or_else(|_| "127.0.0.1:19621".into());
    let listener = TcpListener::bind(http_address).expect("bind HTTP server");
    let frame_listener = TcpListener::bind(frame_address).expect("bind frame server");

    println!("HTTP listening on {}", listener.local_addr().unwrap());
    println!(
        "Frame listening on {}",
        frame_listener.local_addr().unwrap()
    );

    let frame_store = Arc::clone(&store);
    let frame_thread = std::thread::spawn(move || {
        frame_listener
            .set_nonblocking(true)
            .expect("set frame listener nonblocking");
        loop {
            match frame_listener.accept() {
                Ok((mut stream, _)) => {
                    let store = Arc::clone(&frame_store);
                    std::thread::spawn(move || handle_frame_connection(&mut stream, store));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });

    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let services = Arc::clone(&services);
                std::thread::spawn(move || handle_http_connection(&mut stream, services));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(_) => break,
        }
    }

    // Drop the listeners; process shutdown is driven by Ctrl+C or process termination.
    frame_thread.join().unwrap();
    println!("Server stopped");
}

fn handle_http_connection(stream: &mut TcpStream, services: Arc<AppServices>) {
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap_or_default();
    let mut request_reader = RequestReader::new(65536);
    let mut buffer = [0u8; 4096];
    let request = loop {
        let read = stream.read(&mut buffer).unwrap_or(0);
        if read == 0 {
            return;
        }
        match request_reader.feed(&buffer[..read]) {
            Ok(Some(request)) => break request,
            Ok(None) => continue,
            Err(_) => return,
        }
    };
    let state = AppState::default();
    let handler = http::RequestHandler::Services(&services);
    let result = http::route_with_handler(&request.bytes, state, &handler);
    let status = response_status(&result);
    let response = http::response_for(result);
    let _ = stream.write_all(&response);
    println!("HTTP request completed with status {}", status);
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
