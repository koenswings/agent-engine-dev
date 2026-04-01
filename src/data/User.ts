import { UserID } from './CommonTypes.js'

/**
 * A Console operator with a bcrypt-hashed password.
 *
 * Stored in the Automerge Store under `userDB`.
 * Authentication happens client-side in the Console (bcryptjs compare).
 * Writes back to the store via handle.change().
 */
export interface User {
    id: UserID
    username: string
    passwordHash: string   // bcrypt hash — never stored in plain text
}
