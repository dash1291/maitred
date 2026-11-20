import { obj, opt, str } from "@earendil-works/pi-schema";
import { defineSignal } from "@earendil-works/pi-durable";

// You (via Telegram) confirming a booking attempt right before we fire the
// booking POST: "authorize INR 2000 deposit for 4 @ Sat 19:00?" -> delivered.
export const Confirm = defineSignal({
  name: "maitred.confirm",
  version: 1,
  schema: obj({ approved: str(), note: opt(str()) }),
});

// OTP relay from your phone for platforms demanding SMS verification.
export const Otp = defineSignal({
  name: "maitred.otp",
  version: 1,
  schema: obj({ code: str() }),
});

// Out-of-band control: "cancel my guerilla watch", "try 20:00 instead".
export const Control = defineSignal({
  name: "maitred.control",
  version: 1,
  schema: obj({ action: str(), arg: opt(str()) }),
});
