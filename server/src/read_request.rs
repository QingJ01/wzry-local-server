pub const MAX_HEADER_BYTES: usize = 65536;

#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    pub bytes: Vec<u8>,
    pub body: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RequestError {
    HeadersTooLarge,
    BodyTooLarge,
    InvalidContentLength,
}

pub struct RequestReader {
    limit: usize,
    buffer: Vec<u8>,
}

impl RequestReader {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            buffer: Vec::new(),
        }
    }

    pub fn feed(&mut self, input: &[u8]) -> Result<Option<Request>, RequestError> {
        self.buffer.extend_from_slice(input);
        let Some(header_end) = find_header_end(&self.buffer) else {
            if self.buffer.len() > self.limit {
                return Err(RequestError::HeadersTooLarge);
            }
            return Ok(None);
        };
        let headers = &self.buffer[..header_end];
        let content_length = content_length(headers).unwrap_or(0);
        if content_length > self.limit.saturating_sub(headers.len()) {
            return Err(RequestError::BodyTooLarge);
        }
        let total = header_end + content_length;
        if self.buffer.len() < total {
            return Ok(None);
        }
        let request = Request {
            bytes: self.buffer[..total].to_vec(),
            body: self.buffer[header_end..total].to_vec(),
        };
        self.buffer.drain(..total);
        Ok(Some(request))
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
}

fn content_length(headers: &[u8]) -> Option<usize> {
    let headers = String::from_utf8_lossy(headers);
    headers.split("\r\n").find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.eq_ignore_ascii_case("Content-Length") {
            return None;
        }
        value.trim().parse().ok()
    })
}
