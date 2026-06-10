/**
 * Minimal type declarations for the `africastalking` SDK, which ships no types.
 * Covers only the SMS surface this project uses — extend as needed.
 */
declare module 'africastalking' {
  interface SmsRecipient {
    statusCode: number;
    number: string;
    status: string;
    cost: string;
    messageId: string;
  }

  interface SendSmsResponse {
    SMSMessageData: {
      Message: string;
      Recipients: SmsRecipient[];
    };
  }

  interface SmsModule {
    send(options: { to: string | string[]; message: string; from?: string }): Promise<SendSmsResponse>;
  }

  interface AfricasTalkingClient {
    SMS: SmsModule;
  }

  interface AfricasTalkingCredentials {
    apiKey: string;
    username: string;
  }

  function AfricasTalking(credentials: AfricasTalkingCredentials): AfricasTalkingClient;

  export = AfricasTalking;
}
