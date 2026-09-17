#!/usr/bin/env python3
"""Make the upstream NanoTrack V2 fully convolutional backbone's spatial metadata dynamic.

The upstream ONNX export declares 255x255 even though inference requires both
127x127 templates and 255x255 searches. ONNX Runtime enforces that declaration.
This dependency-free protobuf edit changes ONLY spatial Dimension metadata in
4D graph inputs, outputs, and intermediate value-info. Tensor weights, graph
nodes, operators, and initializers are preserved byte-for-byte.

Usage: python3 tools/prepare-nanotrack.py original-backbone.onnx backbone.onnx
An in-place path is supported. Prints source and derived SHA-256 for provenance.
"""
import hashlib
import pathlib
import re
import sys


def varint(data, offset):
    value = shift = 0
    while True:
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7f) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7
        if shift > 64:
            raise ValueError('Invalid protobuf varint')


def encode(value):
    result = bytearray()
    while value > 0x7f:
        result.append((value & 0x7f) | 0x80)
        value >>= 7
    result.append(value)
    return bytes(result)


def fields(data):
    offset = 0
    while offset < len(data):
        start = offset
        tag, offset = varint(data, offset)
        field, wire = tag >> 3, tag & 7
        if wire == 2:
            size, offset = varint(data, offset)
            payload = data[offset:offset+size]
            offset += size
        elif wire == 0:
            _, end = varint(data, offset)
            payload = data[offset:end]
            offset = end
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            payload = data[offset:offset+size]
            offset += size
        else:
            raise ValueError(f'Unsupported wire type {wire}')
        yield field, wire, payload, data[start:offset]


def packed(field, payload):
    return encode(field << 3 | 2) + encode(len(payload)) + payload


changed = 0


def patch_shape(data, prefix):
    global changed
    parts = list(fields(data))
    dims = [part for part in parts if part[0] == 1 and part[1] == 2]
    if len(dims) != 4:
        return data
    output = []
    index = 0
    for field, wire, payload, original in parts:
        if field == 1 and wire == 2:
            if index >= 2:
                symbolic = packed(2, f'{prefix}_spatial_{index}'.encode())
                output.append(packed(1, symbolic))
                changed += 1
            else:
                output.append(original)
            index += 1
        else:
            output.append(original)
    return b''.join(output)


def patch_tensor_type(data, prefix):
    return b''.join(packed(field, patch_shape(payload, prefix)) if field == 2 and wire == 2 else original
                    for field, wire, payload, original in fields(data))


def patch_type(data, prefix):
    return b''.join(packed(field, patch_tensor_type(payload, prefix)) if field == 1 and wire == 2 else original
                    for field, wire, payload, original in fields(data))


def patch_value_info(data):
    parts = list(fields(data))
    name = next((payload.decode() for field, wire, payload, _ in parts if field == 1 and wire == 2), 'tensor')
    prefix = re.sub(r'\W', '_', name)
    return b''.join(packed(field, patch_type(payload, prefix)) if field == 2 and wire == 2 else original
                    for field, wire, payload, original in parts)


def patch_graph(data):
    return b''.join(packed(field, patch_value_info(payload)) if field in (11, 12, 13) and wire == 2 else original
                    for field, wire, payload, original in fields(data))


def patch_model(data):
    return b''.join(packed(field, patch_graph(payload)) if field == 7 and wire == 2 else original
                    for field, wire, payload, original in fields(data))


def graph_content(data):
    graph = next(payload for field, wire, payload, _ in fields(data) if field == 7 and wire == 2)
    return [original for field, _, _, original in fields(graph) if field not in (11, 12, 13)]


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    source_path, output_path = map(pathlib.Path, sys.argv[1:])
    source = source_path.read_bytes()
    output = patch_model(source)
    assert graph_content(source) == graph_content(output), 'An operator or weight was unexpectedly changed'
    if not changed:
        raise SystemExit('No 4D spatial metadata found; refusing to produce an unchanged model')
    output_path.write_bytes(output)
    print(f'source sha256:  {hashlib.sha256(source).hexdigest()}')
    print(f'derived sha256: {hashlib.sha256(output).hexdigest()}')
    print(f'Updated {changed} spatial dimensions. Operators and weights unchanged.')
