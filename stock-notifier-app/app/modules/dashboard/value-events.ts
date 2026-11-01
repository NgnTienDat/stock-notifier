// React 18's synthetic onChange does not handle custom-element change events.
export function bindValueChange(
  element: EventTarget & { value: string },
  onChange: (value: string) => void,
) {
  const listener = () => onChange(element.value);
  element.addEventListener("change", listener);
  return () => element.removeEventListener("change", listener);
}
