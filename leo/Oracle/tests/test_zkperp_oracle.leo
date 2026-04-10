// The 'test_zkperp_oracle' test program.
import zkperp_oracle.aleo;
program test_zkperp_oracle.aleo {
    @test
    @should_fail
    fn test_main_fails() {
        let result: u32 = zkperp_oracle.aleo::main(2u32, 3u32);
        assert_eq(result, 3u32);
    }

    @noupgrade
    constructor() {}
}
