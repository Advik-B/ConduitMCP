extends Node

# Phase 9 fixture: a conduit_tools node with a declared subset. Only the
# methods named in conduit_tool_methods may surface.

var conduit_tool_methods := ["only_this"]


func only_this() -> String:
	return "declared"


func hidden_method() -> int:
	return 7
