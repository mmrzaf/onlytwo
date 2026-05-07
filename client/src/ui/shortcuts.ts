export function setupKeyboardShortcuts(opts: {
  chatForm: HTMLFormElement;
  messageInput: HTMLInputElement;
  modal: HTMLDivElement;
  joinInput: HTMLInputElement;
}) {
  const { chatForm, messageInput, modal, joinInput } = opts;

  document.addEventListener("keydown", (e) => {
    // Ctrl+Enter to send message
    if (e.ctrlKey && e.key === "Enter" && !messageInput.disabled) {
      chatForm.requestSubmit();
    }
    // Escape to close modal or clear input
    if (e.key === "Escape") {
      if (modal.style.display !== "none") {
        modal.style.display = "none";
      } else {
        messageInput.value = "";
      }
    }
    // Ctrl+K to focus session code input
    if (e.ctrlKey && e.key === "k") {
      e.preventDefault();
      joinInput.focus();
    }
  });
}
