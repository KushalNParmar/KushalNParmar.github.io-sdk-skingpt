# NanoTrack V2 models

Source: [HonglinChu/SiamTrackers](https://github.com/HonglinChu/SiamTrackers/tree/248663fde6bf7c40190cf10ee396d5662919ecd3/NanoTrack), pinned commit 248663fde6bf7c40190cf10ee396d5662919ecd3.

The models come from NanoTrack/models/nanotrackv2. The accompanying NanoTrack Apache 2.0 LICENSE is included.

- head.onnx is the unchanged nanotrack_head_sim.onnx.
- backbone.onnx derives from nanotrack_backbone_sim.onnx. Only spatial dimension metadata on four-dimensional graph inputs, outputs, and intermediate value-info was made symbolic. Operators and learned weights are unchanged.

The original backbone declares a 255×255 input, which ONNX Runtime enforces. NanoTrack requires a 127×127 template as well as a 255×255 search image. Reproduce the compatibility change with:

~~~sh
python3 tools/prepare-nanotrack.py original-backbone.onnx assets/nanotrack/backbone.onnx
~~~

The script asserts that all graph fields outside shape metadata remain identical. Original SHA-256: 530bdd0cd00f19afab79a863e71ba71e3312395a5dc9151af675082bdaaa2fc4. Derived SHA-256: d8c6bcede43ac67068d282edc203acd8b4cfd6bfd94b4271c9fafcd2b51457b8. Full provenance, hashes, and byte sizes are in vendor/sources.json.

Inputs use RGB float32 values in 0–255 range, CHW layout. The template produces [1,48,8,8] features; search produces [1,48,16,16]. Head input1 is the template and input2 is the search. The 16×16 classification/regression response uses stride 16. No object-category detector or per-selection training is involved; a selected live-camera patch initializes the fixed reference features.
