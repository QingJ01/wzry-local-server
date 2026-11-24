use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;

#[test]
fn serves_concurrent_clients() {
    let http_port = free_port();
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_wzry-local-server"))
        .env("WZRY_HTTP_ADDR", format!("127.0.0.1:{http_port}"))
        .env("WZRY_FRAME_ADDR", format!("127.0.0.1:{}", free_port()))
        .spawn()
        .expect("spawn server");
    thread::sleep(std::time::Duration::from_millis(200));

    let result = thread::scope(|scope| {
        let handles: Vec<_> = (0..10)
            .map(|_| {
                scope.spawn(|| {
                    let mut stream = TcpStream::connect(("127.0.0.1", http_port)).unwrap();
                    stream
                        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n")
                        .unwrap();
                    let mut response = [0u8; 4096];
                    let read = stream.read(&mut response).unwrap();
                    response[..read].to_vec()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });

    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(result.len(), 10);
    assert!(result.iter().all(|response| {
        let text = String::from_utf8_lossy(response);
        eprintln!("RESPONSE={text}");
        response.starts_with(b"HTTP/1.1 200")
    }));
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
