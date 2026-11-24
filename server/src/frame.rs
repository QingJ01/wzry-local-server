use std::io::{self, Read};

pub const FRAME_HEADER_SIZE: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameConfig {
    pub max_packet_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub command: u16,
    pub sequence: u16,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub struct FrameParser {
    max_packet_bytes: usize,
    buffer: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    InvalidMagic,
    FrameTooLarge,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::InvalidMagic => write!(formatter, "invalid frame magic"),
            FrameError::FrameTooLarge => write!(formatter, "frame exceeds maximum packet size"),
        }
    }
}

impl std::error::Error for FrameError {}

impl FrameParser {
    pub fn new(config: FrameConfig) -> Self {
        Self {
            max_packet_bytes: config.max_packet_bytes.max(FRAME_HEADER_SIZE + 1),
            buffer: Vec::new(),
        }
    }

    pub fn feed(&mut self, input: &[u8]) -> Result<Vec<Frame>, FrameError> {
        self.buffer.extend_from_slice(input);
        let mut frames = Vec::new();
        loop {
            if self.buffer.len() >= 2 && (self.buffer[0] != 0x57 || self.buffer[1] != 0x5a) {
                return Err(FrameError::InvalidMagic);
            }
            if self.buffer.len() < FRAME_HEADER_SIZE {
                return Ok(frames);
            }
            if self.buffer[0] != 0x57 || self.buffer[1] != 0x5a {
                return Err(FrameError::InvalidMagic);
            }
            let body_length = usize::from(u16::from_le_bytes([self.buffer[6], self.buffer[7]]));
            let frame_length = FRAME_HEADER_SIZE + body_length;
            if frame_length > self.max_packet_bytes {
                return Err(FrameError::FrameTooLarge);
            }
            if self.buffer.len() < frame_length {
                return Ok(frames);
            }
            let command = u16::from_le_bytes([self.buffer[2], self.buffer[3]]);
            let sequence = u16::from_le_bytes([self.buffer[4], self.buffer[5]]);
            let body = self.buffer[FRAME_HEADER_SIZE..frame_length].to_vec();
            frames.push(Frame {
                command,
                sequence,
                body,
            });
            self.buffer.drain(..frame_length);
        }
    }
}

pub fn read_frame<T: Read>(
    reader: &mut T,
    parser: &mut FrameParser,
    buffer: &mut [u8],
) -> io::Result<Result<Vec<Frame>, FrameError>> {
    loop {
        let read = reader.read(buffer)?;
        if read == 0 {
            return Ok(Ok(Vec::new()));
        }
        match parser.feed(&buffer[..read]) {
            Ok(frames) if frames.is_empty() => continue,
            result => return Ok(result),
        }
    }
}
