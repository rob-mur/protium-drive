@capability:local-access
Feature: Only the user's own clients reach the Drive through the local port

  @id:a-request-under-a-foreign-name-is-refused
  Scenario: A request that names another site is refused before it reaches the Drive
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    When a web page at evil.example lists "Photos" through the serve's port
    Then the serve refuses the web page as misdirected, and the Drive did not list "Photos"

  @id:the-mount-refuses-a-request-without-its-credential
  Scenario: The mount's port refuses a program that lacks the mount's credential
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user mounts the Drive at a folder
    When another program lists "Photos" at the mount's port without the mount's credential
    Then the mount's port refuses the program as unauthorised, and the Drive did not list "Photos"

  @id:the-mount-keeps-its-credential-off-the-command-line
  Scenario: The mount keeps its credential off every command line
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user mounts the Drive at a folder
    When another program reads the mount's processes from the process table
    Then rclone holds the mount's credential in its environment, and no command line of the mount's processes holds it

  @id:the-serve-listens-only-on-loopback-by-default
  Scenario: The serve listens only on the loopback address unless the user names another
    Given a Drive whose My files holds the folder "Photos"
    When the user starts the serve
    And another program reads which addresses the serve's port listens on
    Then the serve's port listens on 127.0.0.1 and on no other address

  @id:a-serve-with-a-credential-file-refuses-a-program-without-it
  Scenario: A serve started with a credential file refuses a program that lacks the credential
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user keeps the serve's credential in a file only they can read
    When another program lists "Photos" at the serve's port without the serve's credential
    Then the serve's port refuses the program as unauthorised, and the Drive did not list "Photos"

  @id:a-serve-with-a-credential-file-refuses-a-wrong-credential
  Scenario: A serve started with a credential file refuses a program that sends a wrong credential
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user keeps the serve's credential in a file only they can read
    When another program lists "Photos" at the serve's port with a wrong credential
    Then the serve's port refuses the program as unauthorised, and the Drive did not list "Photos"

  @id:a-serve-with-a-credential-file-answers-a-client-that-sends-it
  Scenario: A serve started with a credential file answers the user's client that sends the credential
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user keeps the serve's credential in a file only they can read
    When the user lists "Photos"
    Then the listing shows exactly:
      | name      | kind | size |
      | beach.jpg | file | 12   |

  @id:a-serve-refuses-a-credential-file-other-users-can-read
  Scenario: A serve refuses to start with a credential file that other users can read
    Given a Drive whose My files holds the folder "Photos"
    And the user keeps the serve's credential in a file that other users can read
    When the user starts the serve
    Then the serve exits 1 saying "chmod 600"
