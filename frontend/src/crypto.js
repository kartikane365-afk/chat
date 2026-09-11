// Utility for E2EE using Web Crypto API

// Generate a key pair for a new user
export async function generateKeyPair() {
  const keyPair = await window.crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"]
  );

  const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateKeyJwk = await window.crypto.subtle.exportKey("jwk", keyPair.privateKey);

  return { publicKeyJwk, privateKeyJwk };
}

// Encrypt a message using the recipient's public key
export async function encryptMessage(text, recipientPublicKeyJwk) {
  const publicKey = await window.crypto.subtle.importKey(
    "jwk",
    recipientPublicKeyJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );

  const encodedText = new TextEncoder().encode(text);
  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    encodedText
  );

  // Convert ArrayBuffer to Base64
  return btoa(String.fromCharCode(...new Uint8Array(encryptedBuffer)));
}

// Decrypt a message using the user's private key
export async function decryptMessage(encryptedBase64, privateKeyJwk) {
  try {
    const privateKey = await window.crypto.subtle.importKey(
      "jwk",
      privateKeyJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"]
    );

    // Convert Base64 back to ArrayBuffer
    const encryptedBytes = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      privateKey,
      encryptedBytes
    );

    return new TextDecoder().decode(decryptedBuffer);
  } catch (err) {
    console.error("Decryption failed", err);
    return "[Encrypted Message - Decryption Failed]";
  }
}
