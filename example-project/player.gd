extends Node2D

# Minimal driver for the phase 2 acceptance eval: it moves right while the
# move_right action is held (so a held-input test has an observable effect on
# position) and periodically emits a signal carrying a value (so a gd_game_eval
# that awaits a signal has something to await and a value to return).

signal pinged(value)

const SPEED := 200.0

func _ready() -> void:
	var timer := Timer.new()
	timer.wait_time = 0.3
	timer.autostart = true
	timer.timeout.connect(_on_timer_timeout)
	add_child(timer)

func _on_timer_timeout() -> void:
	pinged.emit(42)

func _process(delta: float) -> void:
	if Input.is_action_pressed("move_right"):
		position.x += SPEED * delta
