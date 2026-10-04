// Both forms submit to the existing account schemas/services. Empty edit
// passwords preserve stored credentials; create validation requires passwords.
export function accountConnectionPayload(
  form: HTMLFormElement,
  useImapCredentials: boolean,
) {
  const data = new FormData(form);
  return {
    imap: {
      host: data.get("imapHost"),
      port: data.get("imapPort"),
      security: data.get("imapSecurity"),
      username: data.get("imapUsername"),
      password: data.get("imapPassword") || undefined,
    },
    smtp: {
      host: data.get("smtpHost"),
      port: data.get("smtpPort"),
      security: data.get("smtpSecurity"),
      useImapCredentials,
      username: useImapCredentials ? undefined : data.get("smtpUsername"),
      password: useImapCredentials
        ? undefined
        : data.get("smtpPassword") || undefined,
    },
  };
}
