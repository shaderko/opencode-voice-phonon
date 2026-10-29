// This package does not currently expose an RPC contract. The `./rpc` export
// exists because OpenCode's plugin entrypoint resolver probes it before `"."`;
// an explicit empty module keeps that probe from failing.
export {}
