/** Shared logging helpers. One JSON line per event — the only production interface for this Worker. */

export function emit(event: string, fields: object) {
    console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

export function fingerprint(token: string | undefined): string {
    if (!token) return "absent";
    return `len=${token.length} …${token.slice(-4)}`;
}
