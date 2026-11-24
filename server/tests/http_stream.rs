use wzry_local_server::read_request;

#[test]
fn reads_headers_and_exact_content_length_body() {
    let mut parser = read_request::RequestReader::new(1024);
    let request = b"POST /game HTTP/1.1\r\nContent-Length: 4\r\n\r\n{\"a\""[..].to_vec();
    let result = parser.feed(&request[..5]).unwrap();
    assert!(result.is_none());
    let result = parser.feed(&request[5..]).unwrap().unwrap();
    assert_eq!(result.body, b"{\"a\"");
}

#[test]
fn rejects_content_length_over_limit() {
    let mut parser = read_request::RequestReader::new(8);
    let request = b"POST /game HTTP/1.1\r\nContent-Length: 9\r\n\r\n123456789";
    let error = parser.feed(request).unwrap_err();
    assert!(matches!(error, read_request::RequestError::BodyTooLarge));
}
