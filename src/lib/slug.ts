import { customAlphabet } from "nanoid";

const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";

export const generateSlug = customAlphabet(alphabet, 8);
export const generateAdminToken = customAlphabet(alphabet, 24);
