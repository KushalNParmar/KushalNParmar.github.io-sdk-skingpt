#!/usr/bin/env python3
"""Apply only the documented XR lifecycle guards to pinned Three.js r136.

Usage: python3 tools/prepare-three-xr.py upstream-three.min.js vendor/three/three.min.js
The input must be the unmodified upstream build. This does not download code.
"""
from hashlib import sha256
from pathlib import Path
import argparse

UPSTREAM_SHA256 = '404ac94a7c76637465730ffc01c99f818065af5797f34b2f604c9ca29af35182'
REPLACEMENTS = [
    # A native session can end before WebXRManager initializes its animation
    # context. Stopping at that point should still be safe.
    ('stop:function(){t.cancelAnimationFrame(i),e=!1}',
     'stop:function(){null!==t&&t.cancelAnimationFrame(i),e=!1}'),
    # Split the existing comma-expression conditional so it can return after
    # makeXRCompatible without creating a layer for a different/ended session.
    ('this.setSession=async function(l){if(i=l,null!==i){if(f=',
     'this.setSession=async function(l){if(i=l,null!==i){f='),
    ('!0!==m.xrCompatible&&await e.makeXRCompatible(),void 0===i.renderState.layers||!1===t.capabilities.isWebGL2){',
     '!0!==m.xrCompatible&&await e.makeXRCompatible();if(i!==l)return;if(void 0===i.renderState.layers||!1===t.capabilities.isWebGL2){'),
    # Resolve into a local value before committing the reference space or loop.
    # A previous setup may finish after its session ended and another began.
    ('this.setFoveation(1),s=await i.requestReferenceSpace(a),U.setContext(i),U.start(),n.isPresenting=!0,n.dispatchEvent({type:"sessionstart"})',
     'this.setFoveation(1);const xrReferenceSpace=await l.requestReferenceSpace(a);if(i!==l)return;s=xrReferenceSpace,U.setContext(l),U.start(),n.isPresenting=!0,n.dispatchEvent({type:"sessionstart"})'),
]


def prepare(source):
    actual = sha256(source).hexdigest()
    if actual != UPSTREAM_SHA256:
        raise ValueError(f'Unexpected input SHA-256: {actual}. Supply unmodified Three.js r136.')
    original = source.decode('utf-8')
    result = original
    for old, new in REPLACEMENTS:
        if result.count(old) != 1:
            raise ValueError(f'Expected exactly one lifecycle patch location: {old}')
        result = result.replace(old, new, 1)
    restored = result
    for old, new in reversed(REPLACEMENTS):
        if restored.count(new) != 1:
            raise ValueError(f'Patched location is not unique: {new}')
        restored = restored.replace(new, old, 1)
    if restored != original:
        raise ValueError('Reversing the lifecycle guards changed unrelated source.')
    return result.encode('utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = prepare(args.upstream.read_bytes())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(result)
    print(f'{args.output}: {len(result)} bytes; sha256={sha256(result).hexdigest()}')


if __name__ == '__main__':
    main()
