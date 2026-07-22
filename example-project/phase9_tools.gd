extends Node

# Phase 9 fixture: a conduit_tools node exposing typed, defaulted, and untyped
# methods. Underscore-prefixed methods must never surface as tools.

var last_label := ""
var markers := 0


func spawn_marker(marker_name: String, count: int = 1) -> int:
	last_label = marker_name
	markers += count
	return markers


func get_speed() -> float:
	return 4.5


func echo_variant(v):
	return v


func _internal() -> void:
	pass
