import { articles, type ArticleKey } from "./articles";

export function setupModalHandlers(
  container: HTMLElement,
  modal: HTMLDivElement,
  modalTitle: HTMLHeadingElement,
  modalBody: HTMLDivElement,
  modalClose: HTMLButtonElement,
) {
  container.querySelectorAll<HTMLButtonElement>(".doc-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const key = (e.currentTarget as HTMLButtonElement).dataset
        .article as ArticleKey;
      const article = articles[key];
      modalTitle.innerHTML = article.title;
      modalBody.innerHTML = article.content;
      modal.style.display = "flex";
    });
  });

  modalClose.addEventListener("click", () => {
    modal.style.display = "none";
  });
}
