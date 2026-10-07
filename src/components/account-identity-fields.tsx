"use client";

export type AccountIdentity = {
  displayName: string;
  senderDisplayName: string;
  email: string;
};

export function AccountIdentityFields({
  value,
  onChange,
  emailReadOnly = false,
}: {
  value: AccountIdentity;
  onChange: (value: AccountIdentity) => void;
  emailReadOnly?: boolean;
}) {
  return (
    <div className="settings-fields">
      {(
        [
          ["displayName", "Account name"],
          ["senderDisplayName", "Your name"],
          ["email", "Email address"],
        ] as const
      ).map(([key, label]) => (
        <label key={key}>
          {label}
          <input
            name={key}
            value={value[key]}
            required={key !== "senderDisplayName"}
            type={key === "email" ? "email" : "text"}
            maxLength={
              key === "displayName" ? 100 : key === "email" ? 320 : 200
            }
            readOnly={key === "email" && emailReadOnly}
            onChange={(event) =>
              onChange({ ...value, [key]: event.target.value })
            }
          />
        </label>
      ))}
    </div>
  );
}
