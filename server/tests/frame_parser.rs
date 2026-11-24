use wzry_local_server::{FrameConfig, FrameParser};

fn frame(command: u16, sequence: u16, body: &[u8]) -> Vec<u8> {
    let mut encoded = vec![0x57, 0x5a];
    encoded.extend_from_slice(&command.to_le_bytes());
    encoded.extend_from_slice(&sequence.to_le_bytes());
    encoded.extend_from_slice(&(body.len() as u16).to_le_bytes());
    encoded.extend_from_slice(body);
    encoded
}

#[test]
fn decodes_complete_frame() {
    let mut parser = FrameParser::new(FrameConfig {
        max_packet_bytes: 32,
    });
    let frames = parser.feed(&frame(2, 3, b"ABC")).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].command, 2);
    assert_eq!(frames[0].sequence, 3);
    assert_eq!(frames[0].body, b"ABC");
}

#[test]
fn buffers_split_packets() {
    let mut parser = FrameParser::new(FrameConfig {
        max_packet_bytes: 32,
    });
    let input = frame(1, 2, b"xy");
    assert!(parser.feed(&input[..4]).unwrap().is_empty());
    assert!(parser.feed(&input[4..6]).unwrap().is_empty());
    let frames = parser.feed(&input[6..]).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].body, b"xy");
}

#[test]
fn decodes_sticky_packets() {
    let mut parser = FrameParser::new(FrameConfig {
        max_packet_bytes: 64,
    });
    let mut input = frame(1, 1, b"a");
    input.extend_from_slice(&frame(2, 2, b"b"));
    let frames = parser.feed(&input).unwrap();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0].sequence, 1);
    assert_eq!(frames[1].sequence, 2);
}

#[test]
fn rejects_invalid_magic() {
    let mut parser = FrameParser::new(FrameConfig {
        max_packet_bytes: 32,
    });
    assert_eq!(
        parser.feed(&[0, 1]).unwrap_err(),
        wzry_local_server::frame::FrameError::InvalidMagic
    );
}

#[test]
fn rejects_oversized_frames() {
    let mut parser = FrameParser::new(FrameConfig {
        max_packet_bytes: 8,
    });
    assert_eq!(
        parser.feed(&frame(9, 9, b"abcdef")).unwrap_err(),
        wzry_local_server::frame::FrameError::FrameTooLarge
    );
}
