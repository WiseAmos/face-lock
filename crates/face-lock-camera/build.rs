// build.rs — invokes napi_build::setup() to generate the bindgen glue.
// This is the standard napi-rs build hook. The generated code is in
// target/ and links into the final .so/.dylib/.node.

fn main() {
    napi_build::setup();
}
