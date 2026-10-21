export class UserError extends Error {
    exitCode;
    constructor(message, exitCode = 1) {
        super(message);
        this.name = "UserError";
        this.exitCode = exitCode;
    }
}
//# sourceMappingURL=user-error.js.map