export type SessionState = {
  code: string;
};

export const createSessionState = (): SessionState => ({
  code: "",
});
