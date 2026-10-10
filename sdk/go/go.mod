module github.com/kibertoad/cat-factory/sdk/go

// The SDK has NO dependencies outside the standard library: a client library's dependencies
// become every consumer's dependencies. `iter.Seq` (range-over-func) needs Go 1.23.
go 1.23
