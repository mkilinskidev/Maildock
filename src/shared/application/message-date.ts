export function messageDate(value: string, now = new Date(), locale?: string) {
  const date = new Date(value);
  const today =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return {
    text: new Intl.DateTimeFormat(
      locale,
      today
        ? { hour: "2-digit", minute: "2-digit" }
        : {
            day: "numeric",
            month: "short",
            ...(date.getFullYear() !== now.getFullYear()
              ? { year: "numeric" }
              : {}),
          },
    ).format(date),
    title: date.toLocaleString(locale, {
      dateStyle: "full",
      timeStyle: "long",
    }),
  };
}
