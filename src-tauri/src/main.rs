// Release builds must not pop a console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agent_ui_lib::run()
}
