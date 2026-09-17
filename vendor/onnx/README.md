# ONNX Runtime Web 1.20.1

The JavaScript, MJS glue and WASM files in this directory come from the same official [onnxruntime-web 1.20.1 npm package](https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.20.1.tgz). The package SHA-512 integrity was verified before extraction:

~~~text
sha512-TePF6XVpLL1rWVMIl5Y9ACBQcyCNFThZON/jgElNd9Txb73CIEGlklhYR3UEr1cp5r0rbGI6nDwwrs79g7WjoA==
~~~

The POC sets ort.env.wasm.numThreads = 1 and uses the WASM execution provider. The filename contains threaded, but the configured execution uses one thread and does not require SharedArrayBuffer or cross-origin isolation. Keep these three distribution files at the same version and path. Serve .wasm as application/wasm and .mjs as JavaScript.

LICENSE and ThirdPartyNotices.txt are from the matching microsoft/onnxruntime v1.20.1 release. Origins, byte sizes, and individual SHA-256 hashes are in vendor/sources.json.
