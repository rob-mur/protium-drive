@capability:session-status
Feature: The sign-in status and signing out

  @id:sign-out-removes-the-session
  Scenario: Signing out removes the saved session
    Given the user has signed in
    When the user signs out
    Then the binary says Proton keeps the session until it expires, and the state directory holds no "session.json"
