type TwilioNumber = {
  sid: string;
  phone_number: string;
  friendly_name?: string;
  voice_application_sid?: string | null;
  trunk_sid?: string | null;
};

function credentials() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const username = process.env.TWILIO_API_KEY_SID || accountSid;
  const password = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !username || !password) throw new Error("Twilio REST credentials are not configured");
  return { accountSid, authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

async function twilioRequest(path: string, init?: RequestInit) {
  const { accountSid, authorization } = credentials();
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}${path}`, {
    ...init,
    headers: { Authorization: authorization, ...init?.headers },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(body.message || `Twilio request failed (${response.status})`));
  return body;
}

export async function findOwnedTwilioNumber(phoneNumber: string): Promise<TwilioNumber | null> {
  const query = new URLSearchParams({ PhoneNumber: phoneNumber, PageSize: "20" });
  const body = await twilioRequest(`/IncomingPhoneNumbers.json?${query}`) as { incoming_phone_numbers?: TwilioNumber[] };
  return body.incoming_phone_numbers?.find((number) => number.phone_number === phoneNumber) || null;
}

export async function configureTwilioNumber(numberSid: string, appUrl: string) {
  const body = new URLSearchParams({
    VoiceUrl: `${appUrl}/api/twilio/incoming`,
    VoiceMethod: "POST",
    StatusCallback: `${appUrl}/api/twilio/status`,
    StatusCallbackMethod: "POST",
  });
  return twilioRequest(`/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}
