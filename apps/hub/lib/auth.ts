const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;

export type FetchLike = (
  url: string,
  init?: RequestInit
) => Promise<Response> | Response;

export interface LoginOutcome {
  readonly message: string;
  readonly ok: boolean;
}

export const describeLoginReply = (status: number | null) => {
  if (status === null) {
    return {
      message: "The hub is not answering.",
      ok: false,
    } satisfies LoginOutcome;
  }

  switch (status) {
    case HTTP_OK:
    case HTTP_NO_CONTENT: {
      return {
        message: "Signed in.",
        ok: true,
      } satisfies LoginOutcome;
    }

    case HTTP_BAD_REQUEST: {
      return {
        message: "Enter the hub token.",
        ok: false,
      } satisfies LoginOutcome;
    }

    case HTTP_UNAUTHORIZED:
    case HTTP_FORBIDDEN: {
      return {
        message: "The hub did not accept that token.",
        ok: false,
      } satisfies LoginOutcome;
    }

    case HTTP_NOT_FOUND: {
      return {
        message: "This hub does not support signing in.",
        ok: false,
      } satisfies LoginOutcome;
    }

    case HTTP_CONFLICT: {
      return {
        message: "The hub cannot sign you in right now.",
        ok: false,
      } satisfies LoginOutcome;
    }

    case HTTP_BAD_GATEWAY: {
      return {
        message: "The hub could not complete sign-in.",
        ok: false,
      } satisfies LoginOutcome;
    }

    default: {
      return {
        message: `The hub answered with status ${status}.`,
        ok: false,
      } satisfies LoginOutcome;
    }
  }
};

export const requestLogin = async (token: string, post: FetchLike = fetch) => {
  try {
    const response = await post("/api/login", {
      body: JSON.stringify({ token }),
      cache: "no-store",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    return describeLoginReply(response.status);
  } catch {
    return describeLoginReply(null);
  }
};

export const requestLogout = async (post: FetchLike = fetch) => {
  try {
    await post("/api/logout", {
      cache: "no-store",
      method: "POST",
    });

    return true;
  } catch {
    return false;
  }
};
