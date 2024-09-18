export const getSignatureKey = async (
  orderId: string,
  orderTotal: number,
  integrityKey: string
) => {
  const str = `${orderId}${orderTotal * 100}COP${integrityKey}`;

  const encondedText = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encondedText);
  const hashArray = Array.from(new Uint8Array(hashBuffer));

  const signature = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  return signature;
};
