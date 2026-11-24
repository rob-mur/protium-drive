@capability:needs-login
Feature: A serve that needs a new sign-in stops, and a sign-in cannot race a running serve

  Status 3 means "needs login": a user service can stop on it instead of restarting for ever.

  @id:a-serve-without-a-session-exits-asking-for-protium-drive-auth-login
  Scenario: A serve started without a session exits with the needs-login status
    Given the user has not signed in
    When the user starts the serve
    Then the serve exits 3 saying "protium-drive auth login"

  @id:a-serve-on-a-refused-session-exits-as-needing-login
  Scenario: A serve started on a session Proton refused exits with the needs-login status
    Given a Drive whose My files holds the folder "Photos"
    And Proton has refused the stored session
    When the user starts the serve
    Then the serve exits 3 saying "Proton refused the stored session"

  @id:a-session-refused-mid-run-stops-the-serve-asking-for-protium-drive-auth-login
  Scenario: A serve whose session Proton refuses while it runs exits with the needs-login status
    Given a Drive whose My files holds the folder "Photos"
    And the Proton account refuses the next refresh
    When the access token expires
    And the user lists "Photos"
    Then the serve exits 3 saying "protium-drive auth login"

  @id:signing-in-while-the-serve-runs-is-refused
  Scenario: Signing in while the serve runs is refused, naming the serve
    Given a Drive whose My files holds the folder "Photos"
    When the user starts the serve
    And the user tries to sign in again
    Then signing in exits non-zero, naming the serve's process id, while the serve still answers

  @id:signing-out-while-the-serve-runs-is-refused
  Scenario: Signing out while the serve runs is refused, naming the serve
    Given a Drive whose My files holds the folder "Photos"
    When the user starts the serve
    And the user signs out
    Then signing out exits non-zero, naming the serve's process id, and the state directory still holds "session.json"

  @id:a-mount-without-a-session-exits-asking-for-protium-drive-auth-login
  Scenario: A mount started without a session exits with the needs-login status
    Given the user has not signed in
    And the user mounts the Drive at a folder
    When the user starts the mount
    Then the mount exits 3 saying "protium-drive auth login"

  @id:a-mount-on-a-refused-session-exits-as-needing-login
  Scenario: A mount started on a session Proton refused exits with the needs-login status
    Given a Drive whose My files holds the folder "Photos"
    And Proton has refused the stored session
    And the user mounts the Drive at a folder
    When the user starts the mount
    Then the mount exits 3 saying "Proton refused the stored session"
