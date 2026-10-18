fn main() {
    if termdock_preview::clipboard_helper_entry() {
        return;
    }
    termdock_preview::run();
}
